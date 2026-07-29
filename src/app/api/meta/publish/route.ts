import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { authenticate } from "@/auth/guard";
import {
  createPendingApproval,
  decideApproval,
  executePersistedApproval,
} from "@/agent/tools/approvals";
import { ensureToolsBootstrapped } from "@/agent/tools/bootstrap";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { publishAdsTool } from "@/agent/tools/publish-ads";
import {
  PublishError,
  PublishHumanInputSchema,
  ResolvedPublishPayloadSchema,
} from "@/publish/schemas";
import { resolvePublishPayload } from "@/publish/resolve";
import { createPublication } from "@/publish/chain";
import {
  buildLiveWriteClient,
  campaignReaderFromClient,
} from "@/publish/live-client";
import { getWriteClientOrThrow } from "@/publish/client-factory";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
ensureQueueBootstrapped();
ensureToolsBootstrapped();

/**
 * POST creates a Freigabe only — never executes Meta writes.
 * Budget is accepted here (human form) and sealed into the resolved payload.
 * No status field exists on the request schema.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const body: unknown = await request.json().catch(() => null);
  if (body && typeof body === "object" && "status" in body) {
    return errorResponse(400, "validation_error", { reason: "status_forbidden" });
  }
  if (body && /\bACTIVE\b/.test(JSON.stringify(body))) {
    return errorResponse(400, "validation_error", { reason: "active_forbidden" });
  }

  const parsed = PublishHumanInputSchema.safeParse(body);
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();

  let campaignReader;
  if (parsed.data.campaign.mode === "existing") {
    try {
      const live = await buildLiveWriteClient(
        auth.session.tenantId,
        parsed.data.metaAdAccountId,
      );
      campaignReader = campaignReaderFromClient(getWriteClientOrThrow(live));
    } catch (error) {
      if (error instanceof PublishError) {
        return errorResponse(400, error.code, error.params);
      }
      throw error;
    }
  }

  let resolved;
  try {
    resolved = await resolvePublishPayload(pool, {
      tenantId: auth.session.tenantId,
      userId: auth.session.userId,
      input: parsed.data,
      allowHumanBudget: true,
      campaignReader,
    });
  } catch (error) {
    if (error instanceof PublishError) {
      return errorResponse(400, error.code, error.params);
    }
    throw error;
  }

  const sealed = ResolvedPublishPayloadSchema.parse(resolved);

  const runId = uuidv7();
  await pool.query(
    `INSERT INTO run (id, tenant_id, kind, status, input, created_at, updated_at)
     VALUES ($1, $2, 'publish_request', 'queued', $3::jsonb, now(), now())`,
    [runId, auth.session.tenantId, JSON.stringify(sealed)],
  );

  const approval = await createPendingApproval(pool, {
    tenantId: auth.session.tenantId,
    runId,
    toolName: publishAdsTool.name,
    toolVersion: publishAdsTool.version,
    resolvedPayload: sealed,
    costEstimate: JSON.stringify({ kind: "meta_publish", currency: "EUR" }),
  });

  return NextResponse.json(
    {
      runId,
      approvalId: approval.id,
      resolved: sealed,
      resolvedRequestHash: approval.resolved_request_hash,
      bindingMismatch: sealed.bindingMismatch,
      statusCode: "approval_required",
    },
    { status: 202 },
  );
}

const ExecuteSchema = z.object({
  approvalId: z.string().uuid(),
  approve: z.boolean(),
});

/**
 * Decide Freigabe. On approve, execute the persisted payload (enqueue
 * meta_publish). Worker runs the unchanged sealed payload.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = ExecuteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const decided = await decideApproval(pool, {
    approvalId: parsed.data.approvalId,
    tenantId: auth.session.tenantId,
    userId: auth.session.userId,
    approve: parsed.data.approve,
  });
  if (!decided) return errorResponse(409, "approval_not_decidable");

  if (!parsed.data.approve) {
    return NextResponse.json({ statusCode: "denied", approvalId: decided.id });
  }

  const sealed = ResolvedPublishPayloadSchema.parse(decided.resolved_payload);
  if (sealed.status !== "PAUSED") {
    return errorResponse(400, "validation_error", { reason: "status_must_be_paused" });
  }

  // Create publication rows before enqueue so resume has a stable id.
  const { publicationId } = await createPublication(pool, {
    tenantId: auth.session.tenantId,
    runId: decided.run_id,
    approvalId: decided.id,
    payload: sealed,
  });

  // Patch the persisted approval payload with publicationId for the worker.
  // We do this by wrapping in the tool handler path: execute uses sealed
  // payload; the job family accepts publicationId via a side write on the
  // reserved operation — simpler: store publicationId on publication and
  // let the job look it up by idempotency key / create if missing.
  // Already created above; tool handler enqueues with publicationId null and
  // job's createPublication is idempotent on idempotency_key.

  const executed = await executePersistedApproval(pool, {
    approvalId: decided.id,
    tenantId: auth.session.tenantId,
    ctx: {
      tenantId: auth.session.tenantId,
      userId: auth.session.userId,
      runId: decided.run_id,
      signal: request.signal,
      agentLocale: "de",
    },
  });

  if (executed.outcome === "rejected") {
    return errorResponse(409, executed.code);
  }
  if (executed.outcome === "needs_approval") {
    return errorResponse(409, "approval_required");
  }

  return NextResponse.json({
    statusCode: "queued",
    approvalId: decided.id,
    publicationId,
    result: executed.result,
  });
}
