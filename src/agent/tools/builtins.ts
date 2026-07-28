import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import { defaultSyncWindow } from "@/meta/insight-sync";
import { createRun } from "@/queue/create-run";
import type { ToolDefinition } from "./types";

const GetAccountMetricsInput = z.object({
  metaAdAccountId: z.string().uuid().optional(),
  windowStart: z.string().date().optional(),
  windowEnd: z.string().date().optional(),
});

export const getAccountMetricsTool: ToolDefinition<
  z.infer<typeof GetAccountMetricsInput>,
  unknown
> = {
  name: "get_account_metrics",
  version: "1",
  description: "Read aggregated account metrics for a date window from local sync data.",
  inputSchema: GetAccountMetricsInput,
  kind: "sync",
  costClass: "cheap",
  sideEffect: "readOnly",
  async resolve(raw) {
    const end = raw.windowEnd ?? new Date().toISOString().slice(0, 10);
    const start =
      raw.windowStart ??
      new Date(Date.parse(end) - 29 * 86_400_000).toISOString().slice(0, 10);
    return {
      metaAdAccountId: raw.metaAdAccountId ?? null,
      windowStart: start,
      windowEnd: end,
    };
  },
  async handler(resolved, ctx) {
    const payload = resolved as {
      metaAdAccountId: string | null;
      windowStart: string;
      windowEnd: string;
    };
    const pool = getPool();
    const result = await pool.query(
      `SELECT
         COUNT(DISTINCT d.meta_ad_id)::int AS ad_count,
         COALESCE(SUM(d.spend), 0)::float8 AS spend,
         COALESCE(SUM(d.impressions), 0)::int AS impressions,
         COALESCE(SUM(d.clicks), 0)::int AS clicks
       FROM insight_daily_as_of($1, now()) d
       JOIN insight_sync_run r ON r.id = d.sync_run_id AND r.tenant_id = d.tenant_id
       WHERE ($2::uuid IS NULL OR r.meta_ad_account_id = $2)
         AND d.date >= $3::date AND d.date <= $4::date`,
      [ctx.tenantId, payload.metaAdAccountId, payload.windowStart, payload.windowEnd],
    );
    return {
      windowStart: payload.windowStart,
      windowEnd: payload.windowEnd,
      ...(result.rows[0] ?? { ad_count: 0, spend: 0, impressions: 0, clicks: 0 }),
    };
  },
};

/**
 * list_ads / get_ad_detail contract (see DECISIONS.md):
 * Etappe 2–3 store metrics keyed by meta_ad_id but no ad master data
 * (name, status). These tools therefore return metrics-only rows from
 * local insight tables. A Graph enrichment for names is deferred — inventing
 * a second sync surface mid-Etappe would expand scope without unblocking
 * the tool framework proof.
 */
const ListAdsInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  windowStart: z.string().date().optional(),
  windowEnd: z.string().date().optional(),
});

export const listAdsTool: ToolDefinition<z.infer<typeof ListAdsInput>, unknown> = {
  name: "list_ads",
  version: "1",
  description:
    "List ads known from synced insight data (meta_ad_id + spend). Names are not available yet.",
  inputSchema: ListAdsInput,
  kind: "sync",
  costClass: "cheap",
  sideEffect: "readOnly",
  async resolve(raw) {
    const end = raw.windowEnd ?? new Date().toISOString().slice(0, 10);
    const start =
      raw.windowStart ??
      new Date(Date.parse(end) - 29 * 86_400_000).toISOString().slice(0, 10);
    return { limit: raw.limit ?? 20, windowStart: start, windowEnd: end };
  },
  async handler(resolved, ctx) {
    const payload = resolved as {
      limit: number;
      windowStart: string;
      windowEnd: string;
    };
    const pool = getPool();
    const result = await pool.query(
      `SELECT meta_ad_id,
              COALESCE(SUM(spend), 0)::float8 AS spend,
              COALESCE(SUM(impressions), 0)::int AS impressions,
              COALESCE(SUM(clicks), 0)::int AS clicks
       FROM insight_daily_as_of($1, now())
       WHERE date >= $2::date AND date <= $3::date
       GROUP BY meta_ad_id
       ORDER BY spend DESC
       LIMIT $4`,
      [ctx.tenantId, payload.windowStart, payload.windowEnd, payload.limit],
    );
    return { ads: result.rows, windowStart: payload.windowStart, windowEnd: payload.windowEnd };
  },
};

const GetAdDetailInput = z.object({
  metaAdId: z.string().min(1),
  windowStart: z.string().date().optional(),
  windowEnd: z.string().date().optional(),
});

export const getAdDetailTool: ToolDefinition<z.infer<typeof GetAdDetailInput>, unknown> = {
  name: "get_ad_detail",
  version: "1",
  description: "Get metric detail for one meta_ad_id from local insight data.",
  inputSchema: GetAdDetailInput,
  kind: "sync",
  costClass: "cheap",
  sideEffect: "readOnly",
  async resolve(raw) {
    const end = raw.windowEnd ?? new Date().toISOString().slice(0, 10);
    const start =
      raw.windowStart ??
      new Date(Date.parse(end) - 29 * 86_400_000).toISOString().slice(0, 10);
    return { metaAdId: raw.metaAdId, windowStart: start, windowEnd: end };
  },
  async handler(resolved, ctx) {
    const payload = resolved as {
      metaAdId: string;
      windowStart: string;
      windowEnd: string;
    };
    const pool = getPool();
    const result = await pool.query(
      `SELECT meta_ad_id,
              COALESCE(SUM(spend), 0)::float8 AS spend,
              COALESCE(SUM(impressions), 0)::int AS impressions,
              COALESCE(SUM(clicks), 0)::int AS clicks
       FROM insight_daily_as_of($1, now())
       WHERE meta_ad_id = $2
         AND date >= $3::date AND date <= $4::date
       GROUP BY meta_ad_id`,
      [ctx.tenantId, payload.metaAdId, payload.windowStart, payload.windowEnd],
    );
    return {
      ad: result.rows[0] ?? null,
      windowStart: payload.windowStart,
      windowEnd: payload.windowEnd,
      note: "use insight_window for non-additive reach; daily reach must not be summed",
    };
  },
};

const TriggerMetaSyncInput = z.object({
  metaAdAccountId: z.string().uuid(),
  /** Optional absolute window; defaults applied in resolve. */
  windowDays: z.number().int().min(1).max(90).optional(),
});

export const triggerMetaSyncTool: ToolDefinition<
  z.infer<typeof TriggerMetaSyncInput>,
  unknown
> = {
  name: "trigger_meta_sync",
  version: "1",
  description: "Enqueue a Meta insight sync for an ad account (writes internal state).",
  inputSchema: TriggerMetaSyncInput,
  kind: "async_submit",
  costClass: "moderate",
  sideEffect: "writesInternal",
  jobFamily: "meta_insight_sync",
  async resolve(raw, ctx) {
    // Time-dependent defaults are frozen here and persisted on the approval
    // so a later execute never re-resolves them (auftrag §0.1).
    const pool = getPool();
    const account = await pool.query<{ timezone_name: string }>(
      `SELECT timezone_name FROM meta_ad_account
       WHERE id = $1 AND tenant_id = $2`,
      [raw.metaAdAccountId, ctx.tenantId],
    );
    const timezone = account.rows[0]?.timezone_name ?? "UTC";
    const days = raw.windowDays ?? env.SYNC_BACKFILL_DAYS;
    const window = defaultSyncWindow(timezone, days);
    return {
      metaAdAccountId: raw.metaAdAccountId,
      windowDays: days,
      windowStart: window.start,
      windowEnd: window.end,
      resolvedAt: new Date().toISOString(),
    };
  },
  async handler(resolved, ctx) {
    const payload = resolved as {
      metaAdAccountId: string;
      windowStart: string;
      windowEnd: string;
    };
    const pool = getPool();
    const runId = uuidv7();
    const created = await createRun(pool, {
      runId,
      tenantId: ctx.tenantId,
      family: "meta_insight_sync",
      input: {
        metaAdAccountId: payload.metaAdAccountId,
        syncRunId: runId,
        windowStart: payload.windowStart,
        windowEnd: payload.windowEnd,
      },
    });
    return {
      submittedRunId: runId,
      outcome: created.outcome,
      windowStart: payload.windowStart,
      windowEnd: payload.windowEnd,
    };
  },
};

const JobIdInput = z.object({
  runId: z.string().uuid(),
});

export const getJobStatusTool: ToolDefinition<z.infer<typeof JobIdInput>, unknown> = {
  name: "get_job_status",
  version: "1",
  description: "Read status of a previously submitted job/run.",
  inputSchema: JobIdInput,
  kind: "job_control",
  costClass: "cheap",
  sideEffect: "readOnly",
  resolve: (raw) => raw,
  async handler(resolved, ctx) {
    const { runId } = resolved as { runId: string };
    const pool = getPool();
    const result = await pool.query(
      `SELECT r.status AS run_status, r.turn_phase, j.status AS job_status, j.progress, j.error
       FROM run r
       LEFT JOIN job j ON j.run_id = r.id
       WHERE r.id = $1 AND r.tenant_id = $2`,
      [runId, ctx.tenantId],
    );
    return result.rows[0] ?? null;
  },
};

export const getJobResultTool: ToolDefinition<z.infer<typeof JobIdInput>, unknown> = {
  name: "get_job_result",
  version: "1",
  description: "Read the result of a completed job/run.",
  inputSchema: JobIdInput,
  kind: "job_control",
  costClass: "cheap",
  sideEffect: "readOnly",
  resolve: (raw) => raw,
  async handler(resolved, ctx) {
    const { runId } = resolved as { runId: string };
    const pool = getPool();
    const result = await pool.query(
      `SELECT r.status, r.result, r.error
       FROM run r
       WHERE r.id = $1 AND r.tenant_id = $2`,
      [runId, ctx.tenantId],
    );
    return result.rows[0] ?? null;
  },
};
