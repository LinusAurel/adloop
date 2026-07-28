import { uuidv7 } from "uuidv7";
import { z } from "zod";
import {
  assembleContextPacket,
  loadAdvertiserContentLocale,
} from "@/agent/context-packet";
import { appendRunEvent, setTurnPhase } from "@/agent/run-events";
import { withTransaction, type Queryable } from "@/db/queryable";
import {
  MODE_REQUEST_CODE,
  MODE_TITLE_CODE,
  MODE_TO_PLAYBOOK,
  MODE_TO_RUN_TYPE,
  type StrategistRunType,
} from "@/queue/families/strategist-review";
import { FUNNEL_POSITION_FORMULA_VERSION } from "@/metrics/types";
import deMessages from "../../messages/de.json";
import enMessages from "../../messages/en.json";

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

function lookupMessage(
  catalog: typeof deMessages,
  key: string,
  params: Record<string, string>,
): string {
  const parts = key.split(".");
  let node: unknown = catalog;
  for (const part of parts) {
    if (!node || typeof node !== "object") return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") return key;
  return node.replace(/\{(\w+)\}/g, (_match, name: string) => params[name] ?? `{${name}}`);
}

/** Resolve a catalogue string for the agent model (not persisted as UI prose). */
function resolveForAgent(
  locale: "de" | "en",
  key: string,
  params: Record<string, string>,
): string {
  return lookupMessage(locale === "en" ? enMessages : deMessages, key, params);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

export const AdReviewModeSchema = z.enum(["copychief", "cro", "variations"]);

export const AdReviewRequestSchema = z.object({
  adId: z.string().min(1),
  adAccountId: z.string().uuid(),
  mode: AdReviewModeSchema,
  execute: z.boolean(),
  runId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  chatId: z.string().uuid().optional(),
  analysisWindow: z.object({
    since: z.string().date(),
    until: z.string().date(),
    label: z.string().min(1).optional(),
    dataAsOf: z.string().min(1),
  }),
  /** Funnel-position snapshot for this ad+window — values come from DB, not the client. */
  snapshotId: z.string().uuid().optional(),
});

export type AdReviewRequest = z.infer<typeof AdReviewRequestSchema>;

export type AdReviewPreview = {
  outcome: "preview";
  contextPacket: string;
  costEstimate: "moderate";
  metricDefinition: {
    id: string;
    version: number;
    label: string;
    configuredBy: string;
  };
  analysisWindow: {
    since: string;
    until: string;
    dataAsOf: string;
  };
};

export type AdReviewExecuteResult =
  | {
      outcome: "created";
      runId: string;
      chatId: string;
      creativeStrategyRunId: string;
      runType: StrategistRunType;
      titleCode: string;
      titleParams: { adName: string };
    }
  | { outcome: "idempotent_replay"; runId: string; chatId: string; creativeStrategyRunId: string }
  | { outcome: "conflict"; runId: string }
  | { outcome: "concurrency_conflict"; runType: StrategistRunType; metaAdId: string }
  | { outcome: "snapshot_mismatch" }
  | { outcome: "not_found" };

async function loadFunnelSnapshot(
  db: Queryable,
  params: {
    tenantId: string;
    snapshotId: string;
    metaAdId: string;
    metaAdAccountId: string;
    windowStart: string;
    windowEnd: string;
    dataAsOf: string;
  },
): Promise<
  | {
      id: string;
      score: number | null;
      gateStatus: string;
      gateReasons: string[];
      band: string | null;
      inputs: unknown;
      metricDefinitionId: string | null;
      metricDefinitionVersion: number | null;
      windowStart: string;
      windowEnd: string;
      dataAsOf: string;
    }
  | "mismatch"
  | null
> {
  const result = await db.query<{
    id: string;
    subject_id: string;
    meta_ad_account_id: string;
    window_start: string;
    window_end: string;
    data_as_of: string;
    value: string | null;
    gate_status: string;
    gate_reasons: string[];
    inputs: unknown;
    formula_version: string;
    metric_definition_id: string | null;
    metric_definition_version: number | null;
    data_as_of_matches: boolean;
  }>(
    `SELECT id, subject_id, meta_ad_account_id,
            window_start::text, window_end::text, data_as_of::text,
            value::text, gate_status, gate_reasons, inputs, formula_version,
            metric_definition_id::text, metric_definition_version,
            (data_as_of = $3::timestamptz) AS data_as_of_matches
     FROM metric_snapshot
     WHERE id = $1 AND tenant_id = $2`,
    [params.snapshotId, params.tenantId, params.dataAsOf],
  );
  const row = result.rows[0];
  if (!row) return "mismatch";
  if (
    row.subject_id !== params.metaAdId ||
    row.meta_ad_account_id !== params.metaAdAccountId ||
    row.window_start !== params.windowStart ||
    row.window_end !== params.windowEnd ||
    !row.data_as_of_matches ||
    row.formula_version !== FUNNEL_POSITION_FORMULA_VERSION
  ) {
    return "mismatch";
  }
  const inputs = row.inputs as { band?: string | null } | null;
  return {
    id: row.id,
    score: row.value !== null ? Number(row.value) : null,
    gateStatus: row.gate_status,
    gateReasons: row.gate_reasons,
    band: inputs?.band ?? null,
    inputs: row.inputs,
    metricDefinitionId: row.metric_definition_id,
    metricDefinitionVersion: row.metric_definition_version,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    dataAsOf: row.data_as_of,
  };
}

async function resolveAgentLocale(
  db: Queryable,
  params: { userId: string; tenantId: string },
): Promise<"de" | "en"> {
  const row = await db.query<{ agent_locale: string }>(
    `SELECT agent_locale FROM app_user WHERE id = $1 AND tenant_id = $2`,
    [params.userId, params.tenantId],
  );
  const stored = row.rows[0]?.agent_locale;
  return stored === "en" || stored === "de" ? stored : "de";
}

async function loadAdBoundToAccount(
  db: Queryable,
  params: {
    tenantId: string;
    metaAdId: string;
    metaAdAccountId: string;
    dataAsOf: string;
  },
): Promise<{ name: string } | null> {
  const result = await db.query<{ name: string }>(
    `SELECT name FROM meta_ad_as_of($1::uuid, $2::timestamptz)
     WHERE meta_ad_id = $3 AND meta_ad_account_id = $4
     LIMIT 1`,
    [params.tenantId, params.dataAsOf, params.metaAdId, params.metaAdAccountId],
  );
  return result.rows[0] ?? null;
}

/**
 * Preview path: no run, job, chat, or creative_strategy_run row.
 */
export async function previewAdReview(
  db: Queryable,
  params: {
    tenantId: string;
    userId: string;
    request: AdReviewRequest;
  },
): Promise<AdReviewPreview | { outcome: "snapshot_mismatch" } | { outcome: "not_found" }> {
  const account = await db.query<{ id: string }>(
    `SELECT id FROM meta_ad_account WHERE id = $1 AND tenant_id = $2`,
    [params.request.adAccountId, params.tenantId],
  );
  if (!account.rows[0]) return { outcome: "not_found" };

  const ad = await loadAdBoundToAccount(db, {
    tenantId: params.tenantId,
    metaAdId: params.request.adId,
    metaAdAccountId: params.request.adAccountId,
    dataAsOf: params.request.analysisWindow.dataAsOf,
  });
  if (!ad) return { outcome: "not_found" };

  let funnelSnapshot: Awaited<ReturnType<typeof loadFunnelSnapshot>> = null;
  if (params.request.snapshotId) {
    funnelSnapshot = await loadFunnelSnapshot(db, {
      tenantId: params.tenantId,
      snapshotId: params.request.snapshotId,
      metaAdId: params.request.adId,
      metaAdAccountId: params.request.adAccountId,
      windowStart: params.request.analysisWindow.since,
      windowEnd: params.request.analysisWindow.until,
      dataAsOf: params.request.analysisWindow.dataAsOf,
    });
    if (funnelSnapshot === "mismatch") return { outcome: "snapshot_mismatch" };
  }

  const agentLocale = await resolveAgentLocale(db, params);
  const contentLocale = await loadAdvertiserContentLocale(db, params.tenantId);
  const assembled = await assembleContextPacket(db, {
    tenantId: params.tenantId,
    agentLocale,
    contentLocale,
    windowStart: params.request.analysisWindow.since,
    windowEnd: params.request.analysisWindow.until,
    metaAdAccountId: params.request.adAccountId,
    metaAdId: params.request.adId,
    dataAsOf: params.request.analysisWindow.dataAsOf,
    funnelSnapshot: funnelSnapshot ?? undefined,
  });

  // Re-resolve metric definition version for the response contract.
  const { resolveMetrics } = await import("@/metrics/resolve");
  const resolved = await resolveMetrics({
    pool: db,
    tenantId: params.tenantId,
    adAccountId: params.request.adAccountId,
    windowStart: params.request.analysisWindow.since,
    windowEnd: params.request.analysisWindow.until,
    dataAsOf: params.request.analysisWindow.dataAsOf,
  });

  return {
    outcome: "preview",
    contextPacket: assembled.packet,
    costEstimate: "moderate",
    metricDefinition: {
      id: resolved.metricDefinition.id,
      version: resolved.metricDefinition.version,
      label: resolved.metricDefinition.label,
      configuredBy: resolved.metricDefinition.configuredBy,
    },
    analysisWindow: {
      since: params.request.analysisWindow.since,
      until: params.request.analysisWindow.until,
      dataAsOf: params.request.analysisWindow.dataAsOf,
    },
  };
}

/**
 * Execute path: creates chat + run + job + creative_strategy_run in one
 * transaction. Client supplies runId / message ids. One active run per ad+type.
 */
export async function executeAdReview(
  db: Queryable,
  params: {
    tenantId: string;
    userId: string;
    request: AdReviewRequest;
  },
): Promise<AdReviewExecuteResult> {
  const request = params.request;
  const runType = MODE_TO_RUN_TYPE[request.mode];
  const playbookSlug = MODE_TO_PLAYBOOK[request.mode];

  // P0 — provided chatId must belong to this tenant before anything is created.
  // not_found (not forbidden) so the route is not an existence oracle.
  if (request.chatId) {
    const owned = await db.query<{ id: string }>(
      `SELECT id FROM chat WHERE id = $1 AND tenant_id = $2`,
      [request.chatId, params.tenantId],
    );
    if (!owned.rows[0]) return { outcome: "not_found" };
  }

  const account = await db.query<{ id: string }>(
    `SELECT id FROM meta_ad_account WHERE id = $1 AND tenant_id = $2`,
    [request.adAccountId, params.tenantId],
  );
  if (!account.rows[0]) return { outcome: "not_found" };

  const ad = await loadAdBoundToAccount(db, {
    tenantId: params.tenantId,
    metaAdId: request.adId,
    metaAdAccountId: request.adAccountId,
    dataAsOf: request.analysisWindow.dataAsOf,
  });
  if (!ad) return { outcome: "not_found" };

  let funnelSnapshot: Awaited<ReturnType<typeof loadFunnelSnapshot>> = null;
  if (request.snapshotId) {
    funnelSnapshot = await loadFunnelSnapshot(db, {
      tenantId: params.tenantId,
      snapshotId: request.snapshotId,
      metaAdId: request.adId,
      metaAdAccountId: request.adAccountId,
      windowStart: request.analysisWindow.since,
      windowEnd: request.analysisWindow.until,
      dataAsOf: request.analysisWindow.dataAsOf,
    });
    if (funnelSnapshot === "mismatch") return { outcome: "snapshot_mismatch" };
  }

  const agentLocale = await resolveAgentLocale(db, params);
  const adName = ad.name;
  const titleCode = MODE_TITLE_CODE[request.mode];
  const titleParams = { adName };
  const messageCode = MODE_REQUEST_CODE[request.mode];
  const messageParams = {
    adName,
    since: request.analysisWindow.since,
    until: request.analysisWindow.until,
  };
  // Model-facing text only — never persisted as the visible chat message.
  const agentMessage = resolveForAgent(agentLocale, messageCode, messageParams);

  const analysisWindow = {
    since: request.analysisWindow.since,
    until: request.analysisWindow.until,
    dataAsOf: request.analysisWindow.dataAsOf,
  };

  // chatId intentionally omitted: server-assigned on first create; retries
  // load the existing run before creating anything new.
  const requestFingerprint = {
    userMessageId: request.userMessageId,
    assistantMessageId: request.assistantMessageId,
    messageCode,
    messageParams,
    playbookSlug,
    agentLocale,
    metaAdAccountId: request.adAccountId,
    metaAdId: request.adId,
    analysisWindow,
    snapshotId: request.snapshotId ?? null,
    runType,
  };

  let result: AdReviewExecuteResult;
  try {
    result = await withTransaction(db, async (client) => {
      // Idempotent retry: load existing run first and reuse its chat —
      // never mint a new chatId that would orphan a row or diverge the fingerprint.
      const existingRun = await client.query<{
        tenant_id: string;
        kind: string;
        chat_id: string | null;
        input: unknown;
      }>(
        `SELECT tenant_id, kind, chat_id, input FROM run WHERE id = $1 FOR UPDATE`,
        [request.runId],
      );

      if (existingRun.rows[0]) {
        const row = existingRun.rows[0];
        const mapping = await client.query<{ id: string; chat_id: string }>(
          `SELECT id, chat_id FROM creative_strategy_run WHERE run_id = $1 AND tenant_id = $2`,
          [request.runId, params.tenantId],
        );
        const sameRequest =
          row.tenant_id === params.tenantId &&
          row.kind === runType &&
          canonical(row.input) === canonical(requestFingerprint);
        if (sameRequest && mapping.rows[0]) {
          return {
            outcome: "idempotent_replay" as const,
            runId: request.runId,
            chatId: mapping.rows[0].chat_id,
            creativeStrategyRunId: mapping.rows[0].id,
          };
        }
        return { outcome: "conflict" as const, runId: request.runId };
      }

      const chatId = request.chatId ?? uuidv7();

      // Application-level concurrency hint (DB unique index is the real fence).
      const active = await client.query<{ run_id: string }>(
        `SELECT csr.run_id
         FROM creative_strategy_run csr
         JOIN run r ON r.id = csr.run_id
         JOIN job j ON j.run_id = r.id
         WHERE csr.tenant_id = $1
           AND csr.meta_ad_id = $2
           AND csr.run_type = $3
           AND j.status IN ('queued', 'claimed', 'retry_scheduled', 'cancel_requested')
         LIMIT 1
         FOR UPDATE OF csr`,
        [params.tenantId, request.adId, runType],
      );
      if (active.rows[0] && active.rows[0].run_id !== request.runId) {
        return {
          outcome: "concurrency_conflict" as const,
          runType,
          metaAdId: request.adId,
        };
      }

      await client.query(
        `INSERT INTO chat (id, tenant_id, name, name_code, name_params)
         VALUES ($1, $2, '', $3, $4::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [chatId, params.tenantId, titleCode, JSON.stringify(titleParams)],
      );

      const jobInput = {
        runId: request.runId,
        chatId,
        userMessageId: request.userMessageId,
        assistantMessageId: request.assistantMessageId,
        message: agentMessage,
        playbookSlug,
        agentLocale,
        userId: params.userId,
        metaAdAccountId: request.adAccountId,
        metaAdId: request.adId,
        analysisWindow,
        snapshotId: request.snapshotId,
      };

      const inserted = await client.query(
        `INSERT INTO run (
           id, tenant_id, kind, status, chat_id, input, turn_phase,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'queued', $4, $5::jsonb, 'queued',
           now(), now()
         )
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          request.runId,
          params.tenantId,
          runType,
          chatId,
          JSON.stringify(requestFingerprint),
        ],
      );

      if (!inserted.rows[0]) {
        // Lost a same-runId race after the earlier SELECT missed the row.
        const raced = await client.query<{
          tenant_id: string;
          kind: string;
          input: unknown;
        }>(`SELECT tenant_id, kind, input FROM run WHERE id = $1`, [request.runId]);
        const row = raced.rows[0];
        const mapping = await client.query<{ id: string; chat_id: string }>(
          `SELECT id, chat_id FROM creative_strategy_run WHERE run_id = $1 AND tenant_id = $2`,
          [request.runId, params.tenantId],
        );
        const sameRequest =
          row &&
          row.tenant_id === params.tenantId &&
          row.kind === runType &&
          canonical(row.input) === canonical(requestFingerprint);
        if (sameRequest && mapping.rows[0]) {
          return {
            outcome: "idempotent_replay" as const,
            runId: request.runId,
            chatId: mapping.rows[0].chat_id,
            creativeStrategyRunId: mapping.rows[0].id,
          };
        }
        return { outcome: "conflict" as const, runId: request.runId };
      }

      await client.query(
        `INSERT INTO job (
           id, tenant_id, run_id, family, status, input, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, now(), now())`,
        [uuidv7(), params.tenantId, request.runId, runType, JSON.stringify(jobInput)],
      );

      await client.query(
        `INSERT INTO message (
           id, tenant_id, chat_id, role, content, content_code, content_params, run_id
         ) VALUES ($1, $2, $3, 'user', '', $4, $5::jsonb, $6)`,
        [
          request.userMessageId,
          params.tenantId,
          chatId,
          messageCode,
          JSON.stringify(messageParams),
          request.runId,
        ],
      );
      await client.query(
        `INSERT INTO message (id, tenant_id, chat_id, role, content, run_id)
         VALUES ($1, $2, $3, 'assistant', '', $4)`,
        [request.assistantMessageId, params.tenantId, chatId, request.runId],
      );

      const strategyRunId = uuidv7();
      const payload = {
        steps: [
          {
            id: "snapshot",
            label: "funnel_snapshot",
            detail: request.snapshotId ?? "none",
          },
          {
            id: "window",
            label: "analysis_window",
            detail: `${request.analysisWindow.since}..${request.analysisWindow.until}`,
          },
          {
            id: "data_as_of",
            label: "data_as_of",
            detail: request.analysisWindow.dataAsOf,
          },
        ],
        evidence: {
          snapshotId: request.snapshotId ?? null,
          funnelSnapshot: funnelSnapshot
            ? {
                score: funnelSnapshot.score,
                gateStatus: funnelSnapshot.gateStatus,
                gateReasons: funnelSnapshot.gateReasons,
                band: funnelSnapshot.band,
              }
            : null,
        },
        titleCode,
        titleParams,
      };

      await client.query(
        `INSERT INTO creative_strategy_run (
           id, tenant_id, run_id, chat_id, meta_ad_id, meta_ad_account_id,
           run_type, title, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          strategyRunId,
          params.tenantId,
          request.runId,
          chatId,
          request.adId,
          request.adAccountId,
          runType,
          titleCode,
          JSON.stringify(payload),
        ],
      );

      await setTurnPhase(client, {
        runId: request.runId,
        phase: "queued",
        chatId,
      });
      await appendRunEvent(client, {
        runId: request.runId,
        kind: "activity",
        payload: {
          kind: "activity",
          code: "run_queued",
          params: { runType },
        },
      });

      return {
        outcome: "created" as const,
        runId: request.runId,
        chatId,
        creativeStrategyRunId: strategyRunId,
        runType,
        titleCode,
        titleParams,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error, "job_strategist_review_active_ad_idx")) {
      return {
        outcome: "concurrency_conflict",
        runType,
        metaAdId: request.adId,
      };
    }
    throw error;
  }

  if (result.outcome === "created") {
    await db.query(`SELECT pg_notify('job_available', $1)`, [request.runId]);
  }
  return result;
}
