import { z } from "zod";
import { uuidv7 } from "uuidv7";
import type { PoolClient } from "pg";
import { withTransaction, type Queryable } from "@/db/queryable";
import { sha256Canonical } from "@/lib/canonical-json";
import { env } from "@/lib/env";
import type { ImageProvider, ProviderJob, GenerationResult } from "./provider";
import { GenerationResultSchema } from "./provider";

export const IdempotencyStatusSchema = z.enum(["in_flight", "succeeded", "failed"]);
export type IdempotencyStatus = z.infer<typeof IdempotencyStatusSchema>;

export interface IdempotencyRow {
  key: string;
  tenant_id: string;
  request_hash: string;
  status: IdempotencyStatus;
  result: unknown;
  correlation_id: string;
  provider: string | null;
  provider_job: unknown;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_hash_conflict";
  constructor(message = "same key with different request_hash") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class ProviderUnprotectedCrashError extends Error {
  readonly code = "provider_unprotected_crash";
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ProviderUnprotectedCrashError";
  }
}

/**
 * Stable key from (tenant, operation, fachliche Identität).
 */
export function buildIdempotencyKey(parts: {
  tenantId: string;
  operation: string;
  identity: string;
}): string {
  return `${parts.tenantId}:${parts.operation}:${parts.identity}`;
}

export function hashGenerationRequest(value: unknown): string {
  return sha256Canonical(value);
}

/**
 * Reserve the key BEFORE any external call. Returns:
 * - reserved: first writer; caller must call the provider
 * - replay: prior success with same hash — return stored result
 * - in_flight: prior attempt unfinished — caller must recover, not blind-retry
 * - conflict: same key, different hash
 */
export type ReserveOutcome =
  | { kind: "reserved"; correlationId: string }
  | { kind: "replay"; result: GenerationResult }
  | { kind: "in_flight"; correlationId: string; providerJob: ProviderJob | null }
  | { kind: "conflict" };

export async function reserveIdempotencyKey(
  db: Queryable,
  params: {
    key: string;
    tenantId: string;
    requestHash: string;
    provider: string;
    correlationId?: string;
  },
): Promise<ReserveOutcome> {
  const correlationId = params.correlationId ?? uuidv7();
  return withTransaction(db, async (client) => {
    const existing = await client.query<IdempotencyRow>(
      `SELECT * FROM idempotency_key WHERE key = $1 FOR UPDATE`,
      [params.key],
    );
    let row = existing.rows[0];
    if (!row) {
      const inserted = await client.query<IdempotencyRow>(
        `INSERT INTO idempotency_key (
           key, tenant_id, request_hash, status, correlation_id, provider
         ) VALUES ($1, $2, $3, 'in_flight', $4, $5)
         ON CONFLICT (key) DO NOTHING
         RETURNING *`,
        [params.key, params.tenantId, params.requestHash, correlationId, params.provider],
      );
      if (inserted.rows[0]) {
        return { kind: "reserved", correlationId };
      }
      // Parallel first-writer: lock the row the other transaction inserted.
      const raced = await client.query<IdempotencyRow>(
        `SELECT * FROM idempotency_key WHERE key = $1 FOR UPDATE`,
        [params.key],
      );
      row = raced.rows[0];
      if (!row) {
        throw new Error("idempotency_key_missing_after_conflict");
      }
    }
    if (row.request_hash !== params.requestHash) {
      return { kind: "conflict" };
    }
    if (row.status === "succeeded") {
      const parsed = GenerationResultSchema.safeParse(row.result);
      if (!parsed.success) {
        throw new Error("idempotency_result_corrupt");
      }
      return { kind: "replay", result: parsed.data };
    }
    if (row.status === "failed") {
      // Failed keys may be retried with a new correlation under the same hash
      // only after explicit human decision — for now treat like in_flight
      // escalation surface. Re-reserve by resetting to in_flight with new corr
      // is intentionally NOT done automatically.
      return {
        kind: "in_flight",
        correlationId: row.correlation_id,
        providerJob: parseProviderJob(row.provider_job),
      };
    }
    // in_flight
    return {
      kind: "in_flight",
      correlationId: row.correlation_id,
      providerJob: parseProviderJob(row.provider_job),
    };
  });
}

export async function recordProviderJob(
  db: Queryable,
  params: { key: string; job: ProviderJob },
): Promise<void> {
  await db.query(
    `UPDATE idempotency_key
     SET provider_job = $1::jsonb
     WHERE key = $2 AND status = 'in_flight'`,
    [JSON.stringify(params.job), params.key],
  );
}

export async function completeIdempotencyKey(
  db: Queryable,
  params: { key: string; result: GenerationResult },
): Promise<void> {
  await db.query(
    `UPDATE idempotency_key
     SET status = 'succeeded', result = $1::jsonb, completed_at = now(), error_code = NULL
     WHERE key = $2`,
    [JSON.stringify(params.result), params.key],
  );
}

export async function failIdempotencyKey(
  db: Queryable,
  params: { key: string; errorCode: string },
): Promise<void> {
  await db.query(
    `UPDATE idempotency_key
     SET status = 'failed', error_code = $1, completed_at = now()
     WHERE key = $2 AND status = 'in_flight'`,
    [params.errorCode, params.key],
  );
}

/**
 * Injected crash point for tests (auftrag Fall 4). Production never sets this.
 */
let crashAfterProviderSubmit: ((job: ProviderJob) => Promise<void> | void) | null =
  null;

export function setCrashAfterProviderSubmitForTests(
  hook: ((job: ProviderJob) => Promise<void> | void) | null,
): void {
  crashAfterProviderSubmit = hook;
}

/**
 * Test hook: both concurrent callers reach this before the CAS that grants
 * submit rights — proves the race on two Postgres backends.
 */
let beforeClaimSubmit: (() => Promise<void> | void) | null = null;

export function setBeforeClaimSubmitForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  beforeClaimSubmit = hook;
}

function parseProviderJob(raw: unknown): ProviderJob | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.externalId !== "string" || typeof obj.correlationId !== "string") {
    return null;
  }
  return {
    externalId: obj.externalId,
    correlationId: obj.correlationId,
    raw: obj.raw,
  };
}

export type ProviderCallOutcome =
  | { kind: "result"; result: GenerationResult; job: ProviderJob }
  | {
      kind: "needs_human_check";
      code: "provider_unprotected_crash" | "callback_timeout";
      reason: string;
    }
  | {
      kind: "awaiting_callback";
      deadlineAt: string;
      correlationId: string;
    }
  | { kind: "replay"; result: GenerationResult };

/**
 * Core call path: reserve → submit → (optional crash hook) → persist job →
 * fetchResult / recover. Never blind-retries an in_flight key.
 */
export async function callProviderWithIdempotency(
  db: Queryable,
  params: {
    key: string;
    tenantId: string;
    requestHash: string;
    provider: ImageProvider;
    request: Parameters<ImageProvider["submit"]>[0];
  },
): Promise<ProviderCallOutcome> {
  const reserved = await reserveIdempotencyKey(db, {
    key: params.key,
    tenantId: params.tenantId,
    requestHash: params.requestHash,
    provider: params.provider.id,
  });

  if (reserved.kind === "conflict") {
    throw new IdempotencyConflictError();
  }
  if (reserved.kind === "replay") {
    return { kind: "replay", result: reserved.result };
  }

  if (reserved.kind === "in_flight") {
    // Approval+reserve may have inserted the key before the job started.
    // No provider_job yet ⇒ first attempt: continue to submit.
    // provider_job set (incl. phase=submitting) ⇒ crash window: reconcile.
    if (!reserved.providerJob) {
      return submitAndComplete(db, {
        key: params.key,
        provider: params.provider,
        correlationId: reserved.correlationId,
        request: params.request,
      });
    }
    return recoverInFlight(db, {
      key: params.key,
      provider: params.provider,
      correlationId: reserved.correlationId,
      providerJob: reserved.providerJob,
      request: params.request,
    });
  }

  return submitAndComplete(db, {
    key: params.key,
    provider: params.provider,
    correlationId: reserved.correlationId,
    request: params.request,
  });
}

async function submitAndComplete(
  db: Queryable,
  params: {
    key: string;
    provider: ImageProvider;
    correlationId: string;
    request: Parameters<ImageProvider["submit"]>[0];
  },
): Promise<ProviderCallOutcome> {
  // Atomic compare-and-set: exactly one caller wins the right to submit.
  // Check-then-set leaves a parallel window where two jobs both see
  // provider_job IS NULL and both bill the provider.
  const submittingMarker: ProviderJob = {
    externalId: "pending",
    correlationId: params.correlationId,
    raw: { phase: "submitting" },
  };
  if (beforeClaimSubmit) {
    await beforeClaimSubmit();
  }
  const claimed = await db.query<{ key: string }>(
    `UPDATE idempotency_key
     SET provider_job = $1::jsonb
     WHERE key = $2 AND provider_job IS NULL AND status = 'in_flight'
     RETURNING key`,
    [JSON.stringify(submittingMarker), params.key],
  );
  if (claimed.rows.length === 0) {
    // Lost the race — never submit. Reconcile like a crash recovery.
    return reconcileAfterLostSubmitClaim(db, params);
  }

  const job = await params.provider.submit(params.request, params.correlationId);
  await recordProviderJob(db, { key: params.key, job });

  if (crashAfterProviderSubmit) {
    await crashAfterProviderSubmit(job);
  }

  const result = await params.provider.fetchResult(job, new AbortController().signal);
  await completeIdempotencyKey(db, { key: params.key, result });
  return { kind: "result", result, job };
}

async function reconcileAfterLostSubmitClaim(
  db: Queryable,
  params: {
    key: string;
    provider: ImageProvider;
    correlationId: string;
    request: Parameters<ImageProvider["submit"]>[0];
  },
): Promise<ProviderCallOutcome> {
  const existing = await db.query<IdempotencyRow>(
    `SELECT * FROM idempotency_key WHERE key = $1`,
    [params.key],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error("idempotency_key_missing_after_cas");
  }
  if (row.status === "succeeded") {
    const parsed = GenerationResultSchema.safeParse(row.result);
    if (!parsed.success) throw new Error("idempotency_result_corrupt");
    return { kind: "replay", result: parsed.data };
  }
  const providerJob = parseProviderJob(row.provider_job) ?? {
    externalId: "pending",
    correlationId: row.correlation_id,
    raw: { phase: "submitting" },
  };
  // Peer holds the submit marker. If they already have an external id we can
  // fetch; if still pending we wait — never a second submit.
  if (providerJob.externalId !== "pending") {
    return recoverInFlight(db, {
      key: params.key,
      provider: params.provider,
      correlationId: row.correlation_id,
      providerJob,
      request: params.request,
    });
  }
  return enterAwaitingCallback(db, {
    key: params.key,
    correlationId: row.correlation_id,
    providerJob,
  });
}

async function recoverInFlight(
  db: Queryable,
  params: {
    key: string;
    provider: ImageProvider;
    correlationId: string;
    providerJob: ProviderJob;
    request: Parameters<ImageProvider["submit"]>[0];
  },
): Promise<ProviderCallOutcome> {
  const recovery = params.provider.recovery;
  const stillPending = params.providerJob.externalId === "pending";

  if (recovery.kind === "unprotected") {
    // Do NOT call the provider again. Escalate.
    return {
      kind: "needs_human_check",
      code: "provider_unprotected_crash",
      reason: recovery.reason,
    };
  }

  if (recovery.kind === "native_key") {
    if (!stillPending) {
      // We already have the provider's job id — fetch, do not submit again.
      const result = await params.provider.fetchResult(
        params.providerJob,
        new AbortController().signal,
      );
      await completeIdempotencyKey(db, { key: params.key, result });
      return { kind: "result", result, job: params.providerJob };
    }
    // Response with external id was lost — resubmit with the SAME correlation.
    const job = await params.provider.submit(params.request, params.correlationId);
    await recordProviderJob(db, { key: params.key, job });
    const result = await params.provider.fetchResult(job, new AbortController().signal);
    await completeIdempotencyKey(db, { key: params.key, result });
    return { kind: "result", result, job };
  }

  if (recovery.kind === "correlated_callback") {
    // We are called back — there is nothing to ask. recover() only sees a
    // webhook that already arrived. Never blind-resubmit while pending.
    if (params.provider.recover) {
      const found = await params.provider.recover(params.correlationId);
      if (found) {
        await completeIdempotencyKey(db, { key: params.key, result: found });
        return {
          kind: "result",
          result: found,
          job: stillPending
            ? {
                externalId: `recovered:${params.correlationId}`,
                correlationId: params.correlationId,
              }
            : params.providerJob,
        };
      }
    }
    if (!stillPending) {
      const result = await params.provider.fetchResult(
        params.providerJob,
        new AbortController().signal,
      );
      await completeIdempotencyKey(db, { key: params.key, result });
      return { kind: "result", result, job: params.providerJob };
    }
    return enterAwaitingCallback(db, {
      key: params.key,
      correlationId: params.correlationId,
      providerJob: params.providerJob,
    });
  }

  // lookup_by_correlation — a failed lookup is a trustworthy “nothing landed”.
  if (params.provider.recover) {
    const found = await params.provider.recover(params.correlationId);
    if (found) {
      await completeIdempotencyKey(db, { key: params.key, result: found });
      return {
        kind: "result",
        result: found,
        job: stillPending
          ? {
              externalId: `recovered:${params.correlationId}`,
              correlationId: params.correlationId,
            }
          : params.providerJob,
      };
    }
  }

  if (!stillPending) {
    const result = await params.provider.fetchResult(
      params.providerJob,
      new AbortController().signal,
    );
    await completeIdempotencyKey(db, { key: params.key, result });
    return { kind: "result", result, job: params.providerJob };
  }

  // Nothing under our correlation and no external id — provider never
  // accepted. Safe to submit once more (lookup_by_correlation only).
  return submitAndComplete(db, {
    key: params.key,
    provider: params.provider,
    correlationId: params.correlationId,
    request: params.request,
  });
}

async function enterAwaitingCallback(
  db: Queryable,
  params: {
    key: string;
    correlationId: string;
    providerJob: ProviderJob;
  },
): Promise<ProviderCallOutcome> {
  const existingDeadline = readAwaitingDeadline(params.providerJob);
  const deadlineAt =
    existingDeadline ?? new Date(Date.now() + env.CALLBACK_GRACE_MS).toISOString();

  if (!existingDeadline) {
    await recordProviderJob(db, {
      key: params.key,
      job: {
        externalId: "pending",
        correlationId: params.correlationId,
        raw: {
          phase: "awaiting_callback",
          deadlineAt,
        },
      },
    });
  }

  if (Date.now() >= Date.parse(deadlineAt)) {
    return {
      kind: "needs_human_check",
      code: "callback_timeout",
      reason: `correlated_callback grace elapsed (${deadlineAt})`,
    };
  }

  return {
    kind: "awaiting_callback",
    deadlineAt,
    correlationId: params.correlationId,
  };
}

function readAwaitingDeadline(job: ProviderJob): string | null {
  if (!job.raw || typeof job.raw !== "object") return null;
  const raw = job.raw as { phase?: unknown; deadlineAt?: unknown };
  if (raw.phase !== "awaiting_callback") return null;
  if (typeof raw.deadlineAt !== "string") return null;
  return raw.deadlineAt;
}

/**
 * Atomically consume a tool approval AND reserve the generation idempotency
 * key (auftrag: one transaction).
 */
export async function consumeApprovalAndReserveIdempotency(
  client: PoolClient,
  params: {
    approvalId: string;
    operationId: string;
    tenantId: string;
    toolName: string;
    toolVersion: string;
    resolvedRequestHash: string;
    resolvedPayload: unknown;
    idempotencyKey: string;
    generationRequestHash: string;
    providerId: string;
    correlationId: string;
  },
): Promise<"reserved" | "already_reserved" | "rejected"> {
  const existing = await client.query(
    `SELECT operation_id FROM reserved_operation WHERE operation_id = $1`,
    [params.operationId],
  );
  if (existing.rows[0]) return "already_reserved";

  const updated = await client.query(
    `UPDATE tool_approval
     SET consumed_at = now()
     WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
       AND decided_at IS NOT NULL
     RETURNING id`,
    [params.approvalId],
  );
  if (!updated.rows[0]) return "rejected";

  await client.query(
    `INSERT INTO reserved_operation (
       operation_id, tenant_id, tool_name, tool_version,
       resolved_request_hash, resolved_payload, status, approval_id
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'in_flight', $7)`,
    [
      params.operationId,
      params.tenantId,
      params.toolName,
      params.toolVersion,
      params.resolvedRequestHash,
      JSON.stringify(params.resolvedPayload),
      params.approvalId,
    ],
  );

  await client.query(
    `INSERT INTO idempotency_key (
       key, tenant_id, request_hash, status, correlation_id, provider
     ) VALUES ($1, $2, $3, 'in_flight', $4, $5)
     ON CONFLICT (key) DO NOTHING`,
    [
      params.idempotencyKey,
      params.tenantId,
      params.generationRequestHash,
      params.correlationId,
      params.providerId,
    ],
  );

  return "reserved";
}
