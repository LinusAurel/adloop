import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type {
  JobProgress,
  LeaseWriteResult,
} from "@/queue/types";
import { JobCancelledError } from "@/queue/errors";
import type { ObjectStore } from "@/storage/object-store";
import {
  MetaGraphClient,
  type PageResult,
} from "./graph-client";
import { initialReadiness, ReadinessSchema } from "./oauth";

const NumericString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .transform((value) => Number(value))
  .refine(Number.isFinite);

const ActionValueSchema = z
  .object({
    action_type: z.string().min(1),
    value: NumericString,
  })
  .passthrough();

const VideoActionSchema = z
  .object({
    action_type: z.string(),
    value: NumericString,
  })
  .passthrough();

export const MetaInsightRowSchema = z.object({
  ad_id: z.string().regex(/^\d+$/),
  date_start: z.string().date(),
  date_stop: z.string().date(),
  spend: NumericString,
  impressions: NumericString,
  clicks: NumericString,
  inline_link_clicks: NumericString,
  reach: NumericString,
  frequency: NumericString,
  actions: z.array(ActionValueSchema).optional(),
  action_values: z.array(ActionValueSchema).optional(),
  video_play_actions: z.array(VideoActionSchema).optional(),
  video_p25_watched_actions: z.array(VideoActionSchema).optional(),
  video_p50_watched_actions: z.array(VideoActionSchema).optional(),
  video_p75_watched_actions: z.array(VideoActionSchema).optional(),
  video_p95_watched_actions: z.array(VideoActionSchema).optional(),
  video_p100_watched_actions: z.array(VideoActionSchema).optional(),
  video_thruplay_watched_actions: z.array(VideoActionSchema).optional(),
  video_avg_time_watched_actions: z.array(VideoActionSchema).optional(),
});

export type MetaInsightRow = z.infer<typeof MetaInsightRowSchema>;

export const MetaInsightPageSchema: z.ZodType<
  PageResult<MetaInsightRow>,
  z.ZodTypeDef,
  unknown
> = z.object({
  data: z.array(MetaInsightRowSchema),
  paging: z
    .object({
      next: z.string().url().optional(),
      cursors: z.object({ after: z.string().optional() }).optional(),
    })
    .optional(),
});

const ATTRIBUTION_SPEC = ["1d_view", "7d_click"] as const;
export const META_INSIGHT_FIELDS = [
  "ad_id",
  "date_start",
  "date_stop",
  "spend",
  "impressions",
  "clicks",
  "inline_link_clicks",
  "reach",
  "frequency",
  "actions",
  "action_values",
  "video_play_actions",
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p95_watched_actions",
  "video_p100_watched_actions",
  "video_thruplay_watched_actions",
  "video_avg_time_watched_actions",
] as const;

const QUERY_CONTRACT = {
  level: "ad",
  timeIncrement: 1,
  fields: META_INSIGHT_FIELDS,
  attributionSpec: ATTRIBUTION_SPEC,
};

export const INSIGHT_QUERY_SIGNATURE = createHash("sha256")
  .update(JSON.stringify(QUERY_CONTRACT))
  .digest("hex");

const ASYNC_REPORT_THRESHOLD_DAYS = 30;

export interface SyncWindow {
  start: string;
  end: string;
}

function zonedDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysInclusive(window: SyncWindow): number {
  const start = Date.parse(`${window.start}T00:00:00.000Z`);
  const end = Date.parse(`${window.end}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function defaultSyncWindow(
  timeZone: string,
  backfillDays: number,
  now = new Date(),
): SyncWindow {
  const today = zonedDate(now, timeZone);
  const end = addDays(today, -1);
  return { start: addDays(end, -(backfillDays - 1)), end };
}

function actionValue(
  actions: MetaInsightRow["actions"] | MetaInsightRow["action_values"],
  actionType: string,
): number {
  return actions?.find((action) => action.action_type === actionType)?.value ?? 0;
}

function videoValue(
  actions:
    | MetaInsightRow["video_play_actions"]
    | MetaInsightRow["video_p25_watched_actions"],
): number {
  return actions?.reduce((sum, action) => sum + action.value, 0) ?? 0;
}

interface NormalizedAction {
  actionType: string;
  count: number;
  value: number;
}

function normalizedActions(row: MetaInsightRow): NormalizedAction[] {
  const result = new Map<string, NormalizedAction>();
  for (const action of row.actions ?? []) {
    result.set(action.action_type, {
      actionType: action.action_type,
      count: action.value,
      value: actionValue(row.action_values, action.action_type),
    });
  }
  return [...result.values()].sort((left, right) =>
    left.actionType.localeCompare(right.actionType),
  );
}

export type LeaseWriter = <T>(
  write: (client: PoolClient) => Promise<T>,
  options?: { allowAfterCancellation?: boolean },
) => Promise<LeaseWriteResult<T>>;

export interface ExecuteInsightSyncOptions {
  pool: Pool;
  tenantId: string;
  internalAdAccountId: string;
  externalAdAccountId: string;
  accountTimezone: string;
  apiVersion: string;
  syncRunId: string;
  window: SyncWindow;
  graph: MetaGraphClient;
  objectStore: ObjectStore;
  signal: AbortSignal;
  progress(progress: JobProgress): Promise<void>;
  withLease: LeaseWriter;
}

interface SyncRunCheckpoint {
  pages_fetched: number;
  last_cursor: string | null;
  status: string;
}

function syncingReadiness(completed: number, total: number) {
  const base = initialReadiness();
  base.base_facts = {
    status: "syncing",
    progress: {
      labelCode: "daily_facts",
      completed,
      total,
      percent: total === 0 ? 0 : Math.min(100, Math.round((completed / total) * 100)),
    },
    blocks: ["strategist", "insights"],
    messageCode: "base_facts_syncing",
  };
  return ReadinessSchema.parse(base);
}

function readyReadiness() {
  const base = initialReadiness();
  base.base_facts = {
    status: "ready",
    blocks: [],
    messageCode: "base_facts_ready",
  };
  return ReadinessSchema.parse(base);
}

function failedReadiness(messageCode: string) {
  const base = initialReadiness();
  base.base_facts = {
    status: "error",
    blocks: ["strategist", "insights"],
    messageCode,
  };
  return ReadinessSchema.parse(base);
}

function cancelledReadiness() {
  const base = initialReadiness();
  base.base_facts = {
    status: "optional_pending",
    blocks: ["strategist", "insights"],
    messageCode: "base_facts_sync_cancelled",
  };
  return ReadinessSchema.parse(base);
}

function insightPath(externalAdAccountId: string, window: SyncWindow): string {
  const params = new URLSearchParams({
    fields: META_INSIGHT_FIELDS.join(","),
    level: "ad",
    time_increment: "1",
    action_attribution_windows: JSON.stringify(ATTRIBUTION_SPEC),
    time_range: JSON.stringify({ since: window.start, until: window.end }),
    limit: "500",
  });
  return `/${externalAdAccountId}/insights?${params.toString()}`;
}

async function writeInsightRow(
  client: PoolClient,
  options: ExecuteInsightSyncOptions,
  row: MetaInsightRow,
): Promise<void> {
  const observed = await client.query<{ observed_at: string }>(
    "SELECT clock_timestamp()::text AS observed_at",
  );
  const observedAt = observed.rows[0]!.observed_at;

  const actions = normalizedActions(row);
    await client.query(
      `INSERT INTO insight_daily (
         tenant_id, meta_ad_id, date, spend, impressions, clicks,
         link_clicks, landing_page_views, reach, frequency,
         video_plays, video_p25, video_p50, video_p75, video_p95, video_p100,
         thruplays, avg_seconds_watched, sync_run_id, observed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
       )
       ON CONFLICT (tenant_id, meta_ad_id, date, sync_run_id) DO UPDATE SET
         spend = EXCLUDED.spend,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         link_clicks = EXCLUDED.link_clicks,
         landing_page_views = EXCLUDED.landing_page_views,
         reach = EXCLUDED.reach,
         frequency = EXCLUDED.frequency,
         video_plays = EXCLUDED.video_plays,
         video_p25 = EXCLUDED.video_p25,
         video_p50 = EXCLUDED.video_p50,
         video_p75 = EXCLUDED.video_p75,
         video_p95 = EXCLUDED.video_p95,
         video_p100 = EXCLUDED.video_p100,
         thruplays = EXCLUDED.thruplays,
         avg_seconds_watched = EXCLUDED.avg_seconds_watched,
         observed_at = EXCLUDED.observed_at`,
      [
        options.tenantId,
        row.ad_id,
        row.date_start,
        row.spend,
        row.impressions,
        row.clicks,
        row.inline_link_clicks,
        actionValue(row.actions, "landing_page_view"),
        row.reach,
        row.frequency,
        videoValue(row.video_play_actions),
        videoValue(row.video_p25_watched_actions),
        videoValue(row.video_p50_watched_actions),
        videoValue(row.video_p75_watched_actions),
        videoValue(row.video_p95_watched_actions),
        videoValue(row.video_p100_watched_actions),
        videoValue(row.video_thruplay_watched_actions),
        videoValue(row.video_avg_time_watched_actions),
        options.syncRunId,
        observedAt,
      ],
    );

    const previous = await client.query<{
      action_type: string;
      attribution_spec: string[];
    }>(
      `SELECT DISTINCT a.action_type, a.attribution_spec
       FROM insight_action_daily a
       JOIN insight_sync_run r
         ON r.id = a.sync_run_id
        AND r.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1
         AND a.meta_ad_id = $2
         AND a.date = $3
         AND r.meta_ad_account_id = $4
         AND r.query_signature = $5
         AND r.status = 'succeeded'`,
      [
        options.tenantId,
        row.ad_id,
        row.date_start,
        options.internalAdAccountId,
        INSIGHT_QUERY_SIGNATURE,
      ],
    );
    const current = new Map(actions.map((action) => [action.actionType, action]));
    for (const old of previous.rows) {
      if (
        old.attribution_spec.join(",") === ATTRIBUTION_SPEC.join(",") &&
        !current.has(old.action_type)
      ) {
        current.set(old.action_type, {
          actionType: old.action_type,
          count: 0,
          value: 0,
        });
      }
    }

  for (const action of current.values()) {
      await client.query(
        `INSERT INTO insight_action_daily (
           tenant_id, meta_ad_id, date, action_type, attribution_spec,
           count, value, sync_run_id, observed_at
         ) VALUES (
           $1, $2, $3, $4, $5::text[], $6, $7, $8, $9
         )
         ON CONFLICT (
           tenant_id, meta_ad_id, date, action_type, attribution_spec, sync_run_id
         ) DO UPDATE SET
           count = EXCLUDED.count,
           value = EXCLUDED.value,
           observed_at = EXCLUDED.observed_at`,
        [
          options.tenantId,
          row.ad_id,
          row.date_start,
          action.actionType,
          [...ATTRIBUTION_SPEC].sort(),
          action.count,
          action.value,
          options.syncRunId,
          observedAt,
        ],
      );
  }
}

async function checkpointInsightPage(
  client: PoolClient,
  options: ExecuteInsightSyncOptions,
  page: {
    pageNumber: number;
    requestCursor: string | null;
    nextCursor: string | null;
    raw: unknown;
  },
): Promise<number> {
  const observed = await client.query<{ observed_at: string }>(
    "SELECT clock_timestamp()::text AS observed_at",
  );
  const observedAt = observed.rows[0]!.observed_at;
  await client.query(
    `INSERT INTO insight_sync_page (
       sync_run_id, page_number, request_cursor, next_cursor,
       raw_response, observed_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (sync_run_id, page_number) DO UPDATE SET
       request_cursor = EXCLUDED.request_cursor,
       next_cursor = EXCLUDED.next_cursor,
       raw_response = EXCLUDED.raw_response,
       observed_at = EXCLUDED.observed_at`,
    [
      options.syncRunId,
      page.pageNumber,
      page.requestCursor,
      page.nextCursor,
      JSON.stringify(page.raw),
      observedAt,
    ],
  );
  await client.query(
    `UPDATE insight_sync_run
     SET pages_fetched = GREATEST(pages_fetched, $1),
         last_cursor = $2,
         status = 'running'
     WHERE id = $3 AND tenant_id = $4`,
    [page.pageNumber, page.nextCursor, options.syncRunId, options.tenantId],
  );
  const completed = await client.query<{ count: string }>(
    `SELECT count(DISTINCT date)::text AS count
     FROM insight_daily
     WHERE tenant_id = $1 AND sync_run_id = $2`,
    [options.tenantId, options.syncRunId],
  );
  const completedDays = Number(completed.rows[0]!.count);
  await client.query(
    `UPDATE meta_ad_account
     SET readiness = $1::jsonb, updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [
      JSON.stringify(syncingReadiness(completedDays, daysInclusive(options.window))),
      options.internalAdAccountId,
      options.tenantId,
    ],
  );
  return completedDays;
}

export async function executeInsightSync(
  options: ExecuteInsightSyncOptions,
): Promise<{ syncRunId: string; pagesFetched: number; rawResponseKey: string }> {
  const initialized = await options.withLease(async (client) => {
    await client.query(
      `INSERT INTO insight_sync_run (
         id, tenant_id, meta_ad_account_id, api_version, query_signature,
         window_start, window_end, account_timezone, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running')
       ON CONFLICT (id) DO NOTHING`,
      [
        options.syncRunId,
        options.tenantId,
        options.internalAdAccountId,
        options.apiVersion,
        INSIGHT_QUERY_SIGNATURE,
        options.window.start,
        options.window.end,
        options.accountTimezone,
      ],
    );
    const checkpoint = await client.query<SyncRunCheckpoint>(
      `SELECT pages_fetched, last_cursor, status
       FROM insight_sync_run
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [options.syncRunId, options.tenantId],
    );
    if (!checkpoint.rows[0]) throw new Error("sync_run_not_found");
    if (checkpoint.rows[0].status === "succeeded") return checkpoint.rows[0];
    await client.query(
      `UPDATE meta_ad_account
       SET readiness = $1::jsonb, updated_at = now()
       WHERE id = $2 AND tenant_id = $3`,
      [
        JSON.stringify(syncingReadiness(0, daysInclusive(options.window))),
        options.internalAdAccountId,
        options.tenantId,
      ],
    );
    return checkpoint.rows[0];
  });
  if (!initialized.acquired) throw new JobCancelledError();
  if (initialized.value.status === "succeeded") {
    const existing = await options.pool.query<{ raw_response_key: string }>(
      `SELECT raw_response_key
       FROM insight_sync_run
       WHERE id = $1 AND tenant_id = $2`,
      [options.syncRunId, options.tenantId],
    );
    return {
      syncRunId: options.syncRunId,
      pagesFetched: initialized.value.pages_fetched,
      rawResponseKey: existing.rows[0]!.raw_response_key,
    };
  }

  let pagesFetched = initialized.value.pages_fetched;
  const reportDays = daysInclusive(options.window);
  let path = insightPath(options.externalAdAccountId, options.window);
  if (reportDays > ASYNC_REPORT_THRESHOLD_DAYS && pagesFetched === 0) {
    const query = new URL(path, "https://graph.facebook.com").searchParams;
    const asyncJobId = await options.graph.startAsyncInsights(
      `/${options.externalAdAccountId}/insights`,
      Object.fromEntries(query.entries()),
      options.signal,
    );
    await options.graph.waitForAsyncReport(asyncJobId, {
      signal: options.signal,
      onProgress: async (percent) =>
        options.progress({
          state: "waiting_for_meta_report",
          message: "meta_report_progress",
          percent,
        }),
    });
    path = `/${asyncJobId}/insights?limit=500`;
  }

  try {
    // pages_fetched > 0 with no last_cursor means the final page was already
    // committed and only raw-object upload/finalization remains.
    if (!(pagesFetched > 0 && initialized.value.last_cursor === null)) {
      const offset = pagesFetched;
      await options.graph.paginate({
        path,
        pageSchema: MetaInsightPageSchema,
        resumeCursor: initialized.value.last_cursor,
        signal: options.signal,
        onPage: async (page) => {
          if (options.signal.aborted) throw new JobCancelledError();
          const absolutePage = offset + page.pageNumber;
          for (const row of page.data) {
            const rowWritten = await options.withLease((client) =>
              writeInsightRow(client, options, row),
            );
            if (!rowWritten.acquired) throw new JobCancelledError();
          }
          const checkpointed = await options.withLease((client) =>
            checkpointInsightPage(client, options, {
              pageNumber: absolutePage,
              requestCursor: page.requestCursor,
              nextCursor: page.nextCursor,
              raw: page.raw,
            }),
          );
          if (!checkpointed.acquired) throw new JobCancelledError();
          pagesFetched = absolutePage;
          await options.progress({
            state: "fetching_insights",
            message: "insight_page_fetched",
            percent: Math.min(
              99,
              Math.round((checkpointed.value / Math.max(reportDays, 1)) * 100),
            ),
          });
        },
      });
    }

    const rawPages = await options.pool.query<{ raw_response: unknown }>(
      `SELECT raw_response
       FROM insight_sync_page
       WHERE sync_run_id = $1
       ORDER BY page_number`,
      [options.syncRunId],
    );
    const rawResponseKey =
      `meta-insights/${options.tenantId}/${options.syncRunId}.json`;
    await options.objectStore.putJson(
      rawResponseKey,
      { pages: rawPages.rows.map((row) => row.raw_response) },
      options.signal,
    );

    const finalized = await options.withLease(async (client) => {
      await client.query(
        `UPDATE insight_sync_run
         SET status = 'succeeded',
             finished_at = clock_timestamp(),
             raw_response_key = $1,
             last_cursor = NULL
         WHERE id = $2 AND tenant_id = $3`,
        [rawResponseKey, options.syncRunId, options.tenantId],
      );
      await client.query(
        `UPDATE meta_ad_account
         SET readiness = $1::jsonb, updated_at = now()
         WHERE id = $2 AND tenant_id = $3`,
        [
          JSON.stringify(readyReadiness()),
          options.internalAdAccountId,
          options.tenantId,
        ],
      );
    });
    if (!finalized.acquired) throw new JobCancelledError();
    await options.progress({
      state: "completed",
      message: "insight_sync_completed",
      percent: 100,
    });
    return { syncRunId: options.syncRunId, pagesFetched, rawResponseKey };
  } catch (error) {
    await options.withLease(
      async (client) => {
        await client.query(
          `UPDATE insight_sync_run
           SET status = 'partial'
           WHERE id = $1 AND tenant_id = $2 AND status <> 'succeeded'`,
          [options.syncRunId, options.tenantId],
        );
        await client.query(
          `UPDATE meta_ad_account
           SET readiness = $1::jsonb, updated_at = now()
           WHERE id = $2 AND tenant_id = $3`,
          [
            JSON.stringify(
              error instanceof JobCancelledError || options.signal.aborted
                ? cancelledReadiness()
                : failedReadiness("base_facts_sync_failed"),
            ),
            options.internalAdAccountId,
            options.tenantId,
          ],
        );
      },
      { allowAfterCancellation: true },
    );
    throw error;
  }
}
