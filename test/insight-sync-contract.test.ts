import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { MetaGraphClient } from "@/meta/graph-client";
import {
  executeInsightSync,
  type ExecuteInsightSyncOptions,
  type LeaseWriter,
} from "@/meta/insight-sync";
import { initialReadiness } from "@/meta/oauth";
import { withTransaction } from "@/db/queryable";
import type { ObjectStore } from "@/storage/object-store";
import { createRun } from "@/queue/create-run";
import { clearRegistry, registerFamily } from "@/queue/registry";
import { metaInsightSyncFamily } from "@/queue/families/meta-insight-sync";
import type { TestDb } from "./db-harness";
import {
  acquireTwoDistinctClients,
  startTestDb,
} from "./db-harness";
import firstPage from "./fixtures/meta/insights-sync-1-page-1.json";
import secondPage from "./fixtures/meta/insights-sync-1-page-2.json";
import thirdPage from "./fixtures/meta/insights-sync-1-page-3.json";
import correction from "./fixtures/meta/insights-sync-2-correction.json";

const firstPageOnly = { data: firstPage.data };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class MemoryObjectStore implements ObjectStore {
  readonly values = new Map<string, unknown>();
  fail = false;

  async putJson(key: string, value: unknown): Promise<void> {
    if (this.fail) throw new Error("synthetic_object_store_failure");
    this.values.set(key, value);
  }
}

describe("insight observation read contract", () => {
  let db: TestDb;
  let accountId: string;
  const externalAccountId = "act_000000000000000";
  let store: MemoryObjectStore;

  beforeAll(async () => {
    db = await startTestDb();
    clearRegistry();
    registerFamily(metaInsightSyncFamily);
  }, 60_000);

  afterAll(async () => {
    clearRegistry();
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM insight_sync_run WHERE tenant_id = $1", [db.tenantId]);
    await db.pool.query("DELETE FROM meta_connection WHERE tenant_id = $1", [db.tenantId]);
    await db.pool.query("DELETE FROM advertiser WHERE tenant_id = $1", [db.tenantId]);

    const advertiserId = uuidv7();
    const connectionId = uuidv7();
    accountId = uuidv7();
    await db.pool.query(
      `INSERT INTO advertiser (id, tenant_id, name, content_locale)
       VALUES ($1, $2, 'Synthetic advertiser', 'de-DE')`,
      [advertiserId, db.tenantId],
    );
    await db.pool.query(
      `INSERT INTO meta_connection (
         id, tenant_id, meta_user_id, token_encrypted, token_expires_at,
         scopes, status
       ) VALUES (
         $1, $2, '000000000000000', 'encrypted-fixture',
         now() + interval '60 days',
         ARRAY['ads_read','ads_management','business_management'],
         'ready'
       )`,
      [connectionId, db.tenantId],
    );
    await db.pool.query(
      `INSERT INTO meta_ad_account (
         id, tenant_id, connection_id, advertiser_id, meta_ad_account_id,
         name, currency, timezone_name, timezone_offset_hours,
         account_status, selected, readiness
       ) VALUES (
         $1, $2, $3, $4, $5, 'Synthetic account', 'EUR',
         'Europe/Berlin', 2, 1, true, $6::jsonb
       )`,
      [
        accountId,
        db.tenantId,
        connectionId,
        advertiserId,
        externalAccountId,
        JSON.stringify(initialReadiness()),
      ],
    );
    store = new MemoryObjectStore();
  });

  function graphFrom(
    responses: unknown[],
    requested: string[] = [],
    listedAdIds?: string[],
  ): MetaGraphClient {
    const queue = [...responses];
    const adIds = listedAdIds ?? [
      ...new Set(
        responses.flatMap((response) => {
          if (!response || typeof response !== "object" || !("data" in response)) return [];
          const data = (response as { data?: unknown }).data;
          if (!Array.isArray(data)) return [];
          return data.flatMap((row) =>
            row && typeof row === "object" && "ad_id" in row
              ? [String(row.ad_id)]
              : [],
          );
        }),
      ),
    ];
    return new MetaGraphClient({
      accessToken: "synthetic-access-token",
      apiVersion: "v25.0",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requested.push(url.toString());
        if (url.pathname.endsWith("/ads")) {
          return jsonResponse({
            data: adIds.map((id) => ({
              id,
              created_time: "2026-01-01T00:00:00+0000",
            })),
          });
        }
        if (/\/\d+\/insights$/.test(url.pathname)) {
          const range = JSON.parse(url.searchParams.get("time_range")!) as {
            since: string;
            until: string;
          };
          if (url.searchParams.get("time_increment") === "1") {
            return jsonResponse({
              data: [
                {
                  ad_id: url.pathname.split("/").at(-2),
                  date_start: "2026-01-01",
                  date_stop: "2026-01-01",
                  impressions: "1",
                },
              ],
            });
          }
          const elapsedDays = Math.max(
            0,
            Math.round(
              (Date.parse(`${range.until}T00:00:00Z`) -
                Date.parse("2026-01-01T00:00:00Z")) /
                86_400_000,
            ),
          );
          const reach = elapsedDays * 10;
          return jsonResponse({
            data: [
              {
                ad_id: url.pathname.split("/").at(-2),
                date_start: range.since,
                date_stop: range.until,
                reach: String(reach),
                frequency: reach === 0 ? "0" : "1.25",
                impressions: String(Math.round(reach * 1.25)),
                spend: String(reach / 100),
              },
            ],
          });
        }
        const next = queue.shift();
        if (!next) throw new Error("synthetic_transport_failure");
        return jsonResponse(next);
      },
    });
  }

  function leaseWriter(): LeaseWriter {
    return async (write) =>
      withTransaction(db.pool, async (client) => ({
        acquired: true as const,
        value: await write(client),
      }));
  }

  function options(
    syncRunId: string,
    graph: MetaGraphClient,
    progress: ExecuteInsightSyncOptions["progress"] = async () => {},
  ): ExecuteInsightSyncOptions {
    return {
      pool: db.pool,
      tenantId: db.tenantId,
      internalAdAccountId: accountId,
      externalAdAccountId: externalAccountId,
      accountTimezone: "Europe/Berlin",
      apiVersion: "v25.0",
      syncRunId,
      window: { start: "2026-07-20", end: "2026-07-20" },
      graph,
      objectStore: store,
      signal: new AbortController().signal,
      progress,
      withLease: leaseWriter(),
    };
  }

  it("moves readiness from syncing to ready, keeps corrected current data, and zeroes missing actions", async () => {
    const readinessStatuses: string[] = [];
    const recordReadiness = async () => {
      const result = await db.pool.query<{
        readiness: { base_facts: { status: string } };
      }>("SELECT readiness FROM meta_ad_account WHERE id = $1", [accountId]);
      readinessStatuses.push(
        result.rows[0]?.readiness.base_facts.status ?? "missing",
      );
    };
    const firstSyncRun = uuidv7();
    await executeInsightSync(
      options(firstSyncRun, graphFrom([firstPageOnly]), recordReadiness),
    );
    const secondSyncRun = uuidv7();
    await executeInsightSync(options(secondSyncRun, graphFrom([correction])));

    expect(readinessStatuses).toContain("syncing");
    expect(readinessStatuses.at(-1)).toBe("ready");

    const raw = await db.pool.query<{
      spend: string;
      sync_run_id: string;
    }>(
      `SELECT spend::text, sync_run_id
       FROM insight_daily
       WHERE tenant_id = $1
         AND meta_ad_id = '000000000000000001'
         AND date = '2026-07-20'
       ORDER BY observed_at`,
      [db.tenantId],
    );
    expect(raw.rows).toHaveLength(2);
    expect(raw.rows.map((row) => Number(row.spend))).toEqual([10, 12.5]);

    const current = await db.pool.query<{ spend: string }>(
      `SELECT spend::text
       FROM insight_daily_current
       WHERE tenant_id = $1
         AND meta_ad_id = '000000000000000001'
         AND date = '2026-07-20'`,
      [db.tenantId],
    );
    expect(current.rows.map((row) => Number(row.spend))).toEqual([12.5]);

    const vanished = await db.pool.query<{ count: string; value: string }>(
      `SELECT count::text, value::text
       FROM insight_action_daily_current
       WHERE tenant_id = $1
         AND meta_ad_id = '000000000000000001'
         AND date = '2026-07-20'
         AND action_type = 'offsite_conversion.fb_pixel_lead'`,
      [db.tenantId],
    );
    expect(vanished.rows).toEqual([{ count: "0", value: "0" }]);
  });

  it("ignores every row from an incomplete sync", async () => {
    const successful = uuidv7();
    await executeInsightSync(options(successful, graphFrom([firstPageOnly])));

    store.fail = true;
    const incomplete = uuidv7();
    await expect(
      executeInsightSync(options(incomplete, graphFrom([correction]))),
    ).rejects.toThrow("synthetic_object_store_failure");

    const status = await db.pool.query<{ status: string }>(
      "SELECT status FROM insight_sync_run WHERE id = $1",
      [incomplete],
    );
    expect(status.rows[0]?.status).toBe("partial");
    const readiness = await db.pool.query<{
      readiness: { base_facts: { status: string; messageCode: string } };
    }>(
      "SELECT readiness FROM meta_ad_account WHERE id = $1",
      [accountId],
    );
    expect(readiness.rows[0]?.readiness.base_facts).toMatchObject({
      status: "error",
      messageCode: "base_facts_sync_failed",
    });
    const current = await db.pool.query<{ spend: string }>(
      `SELECT spend::text
       FROM insight_daily_current
       WHERE tenant_id = $1
         AND meta_ad_id = '000000000000000001'`,
      [db.tenantId],
    );
    expect(current.rows.map((row) => Number(row.spend))).toEqual([10]);
  });

  it("labels only the deduplicated combined-attribution value", async () => {
    const syncRunId = uuidv7();
    await executeInsightSync(options(syncRunId, graphFrom([firstPageOnly])));

    const action = await db.pool.query<{
      attribution_spec: string[];
      count: string;
      value: string;
    }>(
      `SELECT attribution_spec, count::text, value::text
       FROM insight_action_daily_current
       WHERE tenant_id = $1
         AND meta_ad_id = '000000000000000001'
         AND action_type = 'offsite_conversion.fb_pixel_lead'`,
      [db.tenantId],
    );
    expect(action.rows).toEqual([
      {
        attribution_spec: ["1d_view", "7d_click"],
        count: "4",
        value: "400",
      },
    ]);
  });

  it("rejects an action value from a different ad-set attribution setting", async () => {
    const mismatched = structuredClone(firstPageOnly);
    mismatched.data[0]!.attribution_setting = "1d_view_1d_click";

    await expect(
      executeInsightSync(options(uuidv7(), graphFrom([mismatched]))),
    ).rejects.toThrow("Meta response failed schema validation");
  });

  it("writes zero observations when a previously delivered ad-date disappears", async () => {
    const firstSyncRun = uuidv7();
    await executeInsightSync(options(firstSyncRun, graphFrom([firstPageOnly])));

    const secondSyncRun = uuidv7();
    await executeInsightSync(
      options(
        secondSyncRun,
        graphFrom(
          [{ data: [] }],
          [],
          ["000000000000000001", "000000000000000099"],
        ),
      ),
    );

    const daily = await db.pool.query<{
      spend: string;
      impressions: string;
      reach: string;
      sync_run_id: string;
    }>(
      `SELECT spend::text, impressions::text, reach::text, sync_run_id
       FROM insight_daily_current
       WHERE tenant_id = $1
         AND meta_ad_id = '000000000000000001'
         AND date = '2026-07-20'`,
      [db.tenantId],
    );
    expect(daily.rows).toEqual([
      {
        spend: "0",
        impressions: "0",
        reach: "0",
        sync_run_id: secondSyncRun,
      },
    ]);

    const action = await db.pool.query<{ count: string; value: string }>(
      `SELECT count::text, value::text
       FROM insight_action_daily_current
       WHERE tenant_id = $1
         AND meta_ad_id = '000000000000000001'
         AND date = '2026-07-20'
         AND action_type = 'offsite_conversion.fb_pixel_lead'`,
      [db.tenantId],
    );
    expect(action.rows).toEqual([{ count: "0", value: "0" }]);

    const neverDelivered = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM insight_daily
       WHERE tenant_id = $1
         AND meta_ad_id = '000000000000000099'`,
      [db.tenantId],
    );
    expect(neverDelivered.rows).toEqual([{ count: "0" }]);
  });

  it("stores exact comparison and cumulative windows and derives net-new reach", async () => {
    const syncRunId = uuidv7();
    await executeInsightSync(options(syncRunId, graphFrom([firstPageOnly])));

    const windows = await db.pool.query<{
      window_start: string;
      window_end: string;
      is_cumulative: boolean;
    }>(
      `SELECT window_start::text, window_end::text, is_cumulative
       FROM insight_window_current
       WHERE tenant_id = $1 AND meta_ad_id = '000000000000000001'
       ORDER BY is_cumulative, window_start, window_end`,
      [db.tenantId],
    );
    expect(windows.rows.filter((row) => !row.is_cumulative)).toHaveLength(4);
    expect(windows.rows.filter((row) => row.is_cumulative)).toHaveLength(5);

    const derived = await db.pool.query<{
      status: string;
      reason: string | null;
      net_new_reach: string | null;
    }>(
      `SELECT status, reason, net_new_reach::text
       FROM net_new_reach_as_of($1, $2, $3, $4, now())`,
      [
        db.tenantId,
        "000000000000000001",
        "2026-06-21",
        "2026-07-20",
      ],
    );
    expect(derived.rows[0]).toEqual({
      status: "available",
      reason: null,
      net_new_reach: "300",
    });

    const missing = await db.pool.query<{
      status: string;
      reason: string;
      net_new_reach: string | null;
    }>(
      `SELECT status, reason, net_new_reach::text
       FROM net_new_reach_as_of($1, $2, $3, $4, now())`,
      [
        db.tenantId,
        "000000000000000001",
        "2026-06-19",
        "2026-07-20",
      ],
    );
    expect(missing.rows[0]).toEqual({
      status: "insufficient_data",
      reason: "cumulative_reach_missing",
      net_new_reach: null,
    });
  });

  it("reconstructs all three observation tables at an exact data_as_of", async () => {
    const firstSyncRun = uuidv7();
    await executeInsightSync(options(firstSyncRun, graphFrom([firstPageOnly])));
    const cutoff = await db.pool.query<{ finished_at: string }>(
      "SELECT finished_at::text FROM insight_sync_run WHERE id = $1",
      [firstSyncRun],
    );

    const secondSyncRun = uuidv7();
    await executeInsightSync(options(secondSyncRun, graphFrom([correction])));

    const historicalDaily = await db.pool.query<{ spend: string }>(
      `SELECT spend::text
       FROM insight_daily_as_of($1, $2)
       WHERE meta_ad_id = '000000000000000001'`,
      [db.tenantId, cutoff.rows[0]!.finished_at],
    );
    expect(historicalDaily.rows).toEqual([{ spend: "10" }]);

    const historicalActions = await db.pool.query<{ count: string }>(
      `SELECT count::text
       FROM insight_action_daily_as_of($1, $2)
       WHERE meta_ad_id = '000000000000000001'
         AND action_type = 'offsite_conversion.fb_pixel_lead'`,
      [db.tenantId, cutoff.rows[0]!.finished_at],
    );
    expect(historicalActions.rows).toEqual([{ count: "4" }]);

    const historicalWindows = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM insight_window_as_of($1, $2)
       WHERE meta_ad_id = '000000000000000001'`,
      [db.tenantId, cutoff.rows[0]!.finished_at],
    );
    expect(historicalWindows.rows).toEqual([{ count: "9" }]);
  });

  it("persists all three pages and reports pages_fetched = 3", async () => {
    const syncRunId = uuidv7();
    const result = await executeInsightSync(
      options(syncRunId, graphFrom([firstPage, secondPage, thirdPage])),
    );

    expect(result.pagesFetched).toBe(3);
    const rows = await db.pool.query<{ count: string; pages_fetched: number }>(
      `SELECT
         (SELECT count(*)::text FROM insight_daily WHERE sync_run_id = $1) AS count,
         pages_fetched
       FROM insight_sync_run
       WHERE id = $1`,
      [syncRunId],
    );
    expect(rows.rows[0]).toEqual({ count: "3", pages_fetched: 3 });
    expect(store.values.get(result.rawResponseKey)).toMatchObject({
      pages: [firstPage, secondPage, thirdPage],
      windows: { reports: expect.any(Array) },
    });
  });

  it("resumes from the checkpoint cursor after page two fails", async () => {
    const syncRunId = uuidv7();
    await expect(
      executeInsightSync(options(syncRunId, graphFrom([firstPage, secondPage]))),
    ).rejects.toThrow("synthetic_transport_failure");

    const checkpoint = await db.pool.query<{
      pages_fetched: number;
      last_cursor: string;
    }>(
      "SELECT pages_fetched, last_cursor FROM insight_sync_run WHERE id = $1",
      [syncRunId],
    );
    expect(checkpoint.rows[0]).toMatchObject({
      pages_fetched: 2,
      last_cursor: "/v25.0/act_000000000000000/insights?after=insights-cursor-2",
    });

    const requested: string[] = [];
    const result = await executeInsightSync(
      options(syncRunId, graphFrom([thirdPage], requested)),
    );
    expect(result.pagesFetched).toBe(3);
    expect(requested[0]).toContain("after=insights-cursor-2");
    expect(requested[0]).not.toContain("time_range");
  });

  it("rejects a second active sync on a distinct database connection", async () => {
    const clients = await acquireTwoDistinctClients(db.pool);
    const commonInput = {
      metaAdAccountId: accountId,
      windowStart: "2026-07-20",
      windowEnd: "2026-07-26",
    };

    try {
      const [left, right] = await Promise.all([
        createRun(clients.clientA, {
          runId: uuidv7(),
          tenantId: db.tenantId,
          family: "meta_insight_sync",
          input: { ...commonInput, syncRunId: uuidv7() },
        }),
        createRun(clients.clientB, {
          runId: uuidv7(),
          tenantId: db.tenantId,
          family: "meta_insight_sync",
          input: { ...commonInput, syncRunId: uuidv7() },
        }),
      ]);

      expect(clients.pidA).not.toBe(clients.pidB);
      expect([left.outcome, right.outcome].sort()).toEqual([
        "concurrency_conflict",
        "created",
      ]);
    } finally {
      clients.release();
    }
  });
});
