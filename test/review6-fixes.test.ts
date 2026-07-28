import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { uuidv7 } from "uuidv7";
import { GET as getMetricsResolve } from "@/app/api/metrics/resolve/route";
import {
  createSession,
  encodeSession,
  SESSION_COOKIE,
} from "@/auth/session";
import { setPoolForTests } from "@/db/pool";
import { withTransaction } from "@/db/queryable";
import { CreateConversionMetricSchema } from "@/metrics/definition";
import { aggregateNumerator } from "@/metrics/numerator";
import { resolveMetrics } from "@/metrics/resolve";
import { computeAndPersistSnapshots } from "@/metrics/snapshots";
import {
  assignMetricToAdAccount,
  createConversionMetric,
} from "@/metrics/store";
import { FUNNEL_POSITION_FORMULA_VERSION } from "@/metrics/types";
import { MetaGraphClient } from "@/meta/graph-client";
import {
  executeInsightSync,
  type ExecuteInsightSyncOptions,
  type LeaseWriter,
} from "@/meta/insight-sync";
import { HandlerError } from "@/queue/errors";
import { metricSnapshotComputeFamily } from "@/queue/families/metric-snapshot-compute";
import type { JobContext } from "@/queue/types";
import { clearRegistry, registerFamily } from "@/queue/registry";
import type { ObjectStore } from "@/storage/object-store";
import type { TestDb } from "./db-harness";
import { startTestDb } from "./db-harness";
import {
  backdateMetricCreatedAt,
  buildPassingPopulation,
  seedAccountWindow,
  seedDailyRows,
  seedFunnelPopulation,
  seedMetaAccount,
  seedSucceededSync,
  seedWindow,
  type SeedAccount,
} from "./metrics-fixtures";

class MemoryObjectStore implements ObjectStore {
  readonly values = new Map<string, unknown>();

  async putJson(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("review-6 adversarial fixes", () => {
  let db: TestDb;
  let account: SeedAccount;
  let userId: string;

  beforeAll(async () => {
    db = await startTestDb();
    setPoolForTests(db.pool);
    clearRegistry();
    registerFamily(metricSnapshotComputeFamily);
    userId = uuidv7();
    await db.pool.query(
      `INSERT INTO app_user (id, tenant_id, email, role, ui_locale, agent_locale)
       VALUES ($1, $2, 'owner-r6@example.com', 'owner', 'de', 'en')`,
      [userId, db.tenantId],
    );
  }, 60_000);

  afterAll(async () => {
    clearRegistry();
    setPoolForTests(null);
    await db.stop();
  });

  beforeEach(async () => {
    await db.pool.query("DELETE FROM metric_snapshot WHERE tenant_id = $1", [
      db.tenantId,
    ]);
    await db.pool.query(
      "DELETE FROM ad_account_metric_assignment WHERE tenant_id = $1",
      [db.tenantId],
    );
    await db.pool.query("DELETE FROM conversion_metric WHERE tenant_id = $1", [
      db.tenantId,
    ]);
    await db.pool.query("DELETE FROM insight_sync_run WHERE tenant_id = $1", [
      db.tenantId,
    ]);
    await db.pool.query("DELETE FROM meta_ad_account WHERE tenant_id = $1", [
      db.tenantId,
    ]);
    await db.pool.query("DELETE FROM meta_connection WHERE tenant_id = $1", [
      db.tenantId,
    ]);
    await db.pool.query("DELETE FROM advertiser WHERE tenant_id = $1", [
      db.tenantId,
    ]);
    account = await seedMetaAccount(db.pool, db.tenantId, "EUR");
  });

  async function callMetricsResolve(params: {
    metaAdAccountId: string;
    windowStart: string;
    windowEnd: string;
    dataAsOf: string;
  }): Promise<Response> {
    const url = new URL("http://localhost/api/metrics/resolve");
    url.searchParams.set("metaAdAccountId", params.metaAdAccountId);
    url.searchParams.set("windowStart", params.windowStart);
    url.searchParams.set("windowEnd", params.windowEnd);
    url.searchParams.set("dataAsOf", params.dataAsOf);
    const request = new NextRequest(url, {
      headers: {
        cookie: `${SESSION_COOKIE}=${encodeSession(createSession(userId, db.tenantId))}`,
      },
    });
    return getMetricsResolve(request);
  }

  it("finding 1: microsecond finished_at is included in as_of cutoff", async () => {
    const syncRunId = uuidv7();
    await db.pool.query(
      `INSERT INTO insight_sync_run (
         id, tenant_id, meta_ad_account_id, api_version, query_signature,
         window_start, window_end, account_timezone, status,
         started_at, finished_at
       ) VALUES (
         $1, $2, $3, 'v22.0', 'sig', '2026-07-19'::date, '2026-07-19'::date,
         'Europe/Berlin', 'succeeded',
         '2026-07-20 12:00:00.123456+00'::timestamptz,
         '2026-07-20 12:00:00.123456+00'::timestamptz
       )`,
      [syncRunId, db.tenantId, account.accountId],
    );
    await seedDailyRows(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      observedAt: new Date("2026-07-20T12:00:00.123Z"),
      rows: [
        {
          metaAdId: "micro-1",
          date: "2026-07-19",
          spend: 42,
          impressions: 1000,
          linkClicks: 10,
        },
      ],
    });
    // Bump observed_at to the exact microsecond instant via SQL.
    await db.pool.query(
      `UPDATE insight_daily
       SET observed_at = '2026-07-20 12:00:00.123456+00'::timestamptz
       WHERE sync_run_id = $1`,
      [syncRunId],
    );

    const finished = await db.pool.query<{ finished_at: string }>(
      `SELECT finished_at::text AS finished_at FROM insight_sync_run WHERE id = $1`,
      [syncRunId],
    );
    const asText = finished.rows[0]!.finished_at;
    expect(asText).toMatch(/123456/);

    const viaText = await db.pool.query<{ spend: string }>(
      `SELECT spend::text FROM insight_daily_as_of($1, $2::timestamptz)
       WHERE meta_ad_id = 'micro-1'`,
      [db.tenantId, asText],
    );
    expect(viaText.rows).toEqual([{ spend: "42" }]);

    // Truncated Date (ms) would exclude the row without round-up / text cutoff.
    const truncated = new Date("2026-07-20T12:00:00.123Z");
    const viaTruncated = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
      dataAsOf: truncated,
    });
    expect(viaTruncated.rows[0]?.spend).toBe(42);

    const viaExact = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
      dataAsOf: asText,
    });
    expect(viaExact.rows[0]?.spend).toBe(42);
  });

  it("finding 2: completeness uses business key, not query_signature", async () => {
    const oldSig = "etappe2-signature";
    const oldSync = uuidv7();
    const adId = "900000000000000001";
    await db.pool.query(
      `INSERT INTO insight_sync_run (
         id, tenant_id, meta_ad_account_id, api_version, query_signature,
         window_start, window_end, account_timezone, status,
         started_at, finished_at
       ) VALUES (
         $1, $2, $3, 'v22.0', $4, '2026-07-19'::date, '2026-07-19'::date,
         'Europe/Berlin', 'succeeded',
         '2026-07-19T12:00:00Z', '2026-07-19T12:00:00Z'
       )`,
      [oldSync, db.tenantId, account.accountId, oldSig],
    );
    await seedDailyRows(db.pool, {
      tenantId: db.tenantId,
      syncRunId: oldSync,
      observedAt: new Date("2026-07-19T12:00:00.000Z"),
      rows: [
        {
          metaAdId: adId,
          date: "2026-07-19",
          spend: 10,
          impressions: 100,
          actions: [{ actionType: "lead", count: 4, value: 0 }],
        },
      ],
    });

    const { INSIGHT_QUERY_SIGNATURE } = await import("@/meta/insight-sync");
    expect(INSIGHT_QUERY_SIGNATURE).not.toBe(oldSig);

    const external = await db.pool.query<{ meta_ad_account_id: string }>(
      `SELECT meta_ad_account_id FROM meta_ad_account WHERE id = $1`,
      [account.accountId],
    );
    const store = new MemoryObjectStore();
    const leaseWriter: LeaseWriter = async (write) =>
      withTransaction(db.pool, async (client) => ({
        acquired: true as const,
        value: await write(client),
      }));
    // Second sync under today's signature — Meta no longer reports the lead.
    // Must go through executeInsightSync → writeInsightRow so a regression in
    // the tombstone path fails this test.
    const pageWithoutLead = {
      data: [
        {
          ad_id: adId,
          date_start: "2026-07-19",
          date_stop: "2026-07-19",
          spend: "10.00",
          impressions: "100",
          clicks: "0",
          inline_link_clicks: "0",
          reach: "80",
          frequency: "1.25",
          attribution_setting: "1d_view_7d_click",
          actions: [
            {
              action_type: "landing_page_view",
              value: "5",
              "1d_view": "1",
              "7d_click": "4",
            },
          ],
        },
      ],
    };
    const graph = new MetaGraphClient({
      accessToken: "synthetic-access-token",
      apiVersion: "v25.0",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/ads")) {
          return jsonResponse({
            data: [
              {
                id: adId,
                name: "Vanish Ad",
                status: "ACTIVE",
                effective_status: "ACTIVE",
                campaign_id: "200000000000001",
                adset_id: "300000000000001",
                created_time: "2026-01-01T00:00:00+0000",
              },
            ],
          });
        }
        if (
          /\/act_[^/]+\/insights$/.test(url.pathname) &&
          url.searchParams.get("time_increment") === "all_days"
        ) {
          const range = JSON.parse(url.searchParams.get("time_range")!) as {
            since: string;
            until: string;
          };
          return jsonResponse({
            data: [
              {
                date_start: range.since,
                date_stop: range.until,
                reach: "100",
                frequency: "1",
                impressions: "100",
                spend: "10",
              },
            ],
          });
        }
        if (
          new RegExp(`/${adId}/insights$`).test(url.pathname) &&
          url.searchParams.get("time_increment") === "all_days"
        ) {
          const range = JSON.parse(url.searchParams.get("time_range")!) as {
            since: string;
            until: string;
          };
          return jsonResponse({
            data: [
              {
                ad_id: adId,
                date_start: range.since,
                date_stop: range.until,
                reach: "80",
                frequency: "1.25",
                impressions: "100",
                spend: "10",
              },
            ],
          });
        }
        if (
          new RegExp(`/${adId}/insights$`).test(url.pathname) &&
          url.searchParams.get("time_increment") === "1"
        ) {
          return jsonResponse({
            data: [
              {
                ad_id: adId,
                date_start: "2026-01-01",
                date_stop: "2026-01-01",
                impressions: "1",
              },
            ],
          });
        }
        // Account-level daily insights (time_increment=1): the page under test.
        return jsonResponse(pageWithoutLead);
      },
    });
    const syncRunId = uuidv7();
    const options: ExecuteInsightSyncOptions = {
      pool: db.pool,
      tenantId: db.tenantId,
      internalAdAccountId: account.accountId,
      externalAdAccountId: external.rows[0]!.meta_ad_account_id,
      accountTimezone: "Europe/Berlin",
      apiVersion: "v25.0",
      syncRunId,
      window: { start: "2026-07-19", end: "2026-07-19" },
      graph,
      objectStore: store,
      signal: new AbortController().signal,
      progress: async () => {},
      withLease: leaseWriter,
    };
    await executeInsightSync(options);

    const finished = await db.pool.query<{ finished_at: string }>(
      `SELECT finished_at::text AS finished_at FROM insight_sync_run WHERE id = $1`,
      [syncRunId],
    );
    const asOf = await db.pool.query<{ count: string }>(
      `SELECT count::text FROM insight_action_daily_as_of($1, $2::timestamptz)
       WHERE meta_ad_id = $3 AND action_type = 'lead'`,
      [db.tenantId, finished.rows[0]!.finished_at, adId],
    );
    expect(asOf.rows).toEqual([{ count: "0" }]);
  });

  it("finding 3: incomplete daily coverage yields window_incomplete, not a partial rate", async () => {
    // 30-day window, only 7 trailing days present — classic false CVR.
    const windowStart = "2026-06-20";
    const windowEnd = "2026-07-19";
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-07-13",
      windowEnd,
      finishedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    const observedAt = new Date("2026-07-20T12:00:00.000Z");
    for (let day = 13; day <= 19; day += 1) {
      await seedDailyRows(db.pool, {
        tenantId: db.tenantId,
        syncRunId,
        observedAt,
        rows: [
          {
            metaAdId: "partial-1",
            date: `2026-07-${day}`,
            spend: 10,
            impressions: 100,
            clicks: 10,
            linkClicks: 10,
            actions: [
              {
                actionType: "offsite_conversion.fb_pixel_purchase",
                count: 1,
                value: 40,
              },
            ],
          },
        ],
      });
    }
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "partial-1",
      windowStart,
      windowEnd,
      reach: 3000,
      frequency: 1.2,
      observedAt,
    });

    const metric = await createConversionMetric(db.pool, {
      tenantId: db.tenantId,
      input: {
        label: "Purchase",
        numeratorActionTypes: ["offsite_conversion.fb_pixel_purchase"],
        numeratorAggregation: "first_present",
        denominator: "clicks",
        valueSource: "none",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
      },
    });
    await assignMetricToAdAccount(db.pool, {
      tenantId: db.tenantId,
      metaAdAccountId: account.accountId,
      conversionMetricId: metric.id,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    await backdateMetricCreatedAt(db.pool, {
      metricIds: [metric.id],
      metaAdAccountId: account.accountId,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const resolved = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart,
      windowEnd,
      dataAsOf: "2026-07-20T12:00:00.000Z",
    });
    expect(resolved.gateStatus).toBe("insufficient_data");
    expect(resolved.gateReasons).toContain("window_incomplete");
    expect(resolved.missingDateRange).toEqual({
      missingStart: "2026-06-20",
      missingEnd: "2026-07-12",
    });
    // Must not look like a full-window 7/70 = 0.1 CVR.
    expect(resolved.rows[0]?.cvr).toBeNull();
    expect(resolved.rows[0]?.numerator).toBeNull();
  });

  it("finding 4: historical resolve returns prior formula version via route", async () => {
    // Snapshot stored under an older family version than today's constant.
    // The route must still return it; hard-filtering on FUNNEL_POSITION_FORMULA_VERSION
    // yields no_snapshot and fails this test.
    const priorVersion = "funnel_position_v0";
    expect(priorVersion).not.toBe(FUNNEL_POSITION_FORMULA_VERSION);

    const population = buildPassingPopulation();
    const sync1 = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      finishedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    await seedFunnelPopulation(db.pool, account, population, sync1);

    await computeAndPersistSnapshots({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: "2026-07-20T12:00:00.000Z",
      sourceSyncRunIds: [sync1],
    });
    await db.pool.query(
      `UPDATE metric_snapshot
       SET formula_version = $1
       WHERE tenant_id = $2
         AND meta_ad_account_id = $3
         AND data_as_of = $4::timestamptz
         AND formula_version = $5`,
      [
        priorVersion,
        db.tenantId,
        account.accountId,
        "2026-07-20T12:00:00.000Z",
        FUNNEL_POSITION_FORMULA_VERSION,
      ],
    );

    // Newer sync makes 2026-07-20 historical (scoresFromSnapshot path).
    await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      finishedAt: new Date("2026-07-21T12:00:00.000Z"),
    });

    const response = await callMetricsResolve({
      metaAdAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: "2026-07-20T12:00:00.000Z",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scoresFromSnapshot: boolean;
      funnel: {
        formulaVersion: string;
        gateStatus: string;
        gateReasons: string[];
      };
      ads: Array<{
        funnelPosition: {
          gateStatus: string;
          gateReasons: string[];
          score: number | null;
        } | null;
      }>;
    };
    expect(body.scoresFromSnapshot).toBe(true);
    expect(body.funnel.formulaVersion).toBe(priorVersion);
    expect(body.funnel.gateStatus).toBe("ok");
    expect(body.funnel.gateReasons).not.toContain("no_snapshot");
    const scored = body.ads.filter(
      (ad) => ad.funnelPosition && ad.funnelPosition.score !== null,
    );
    expect(scored.length).toBeGreaterThan(0);

    const missing = await callMetricsResolve({
      metaAdAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: "2026-07-15T12:00:00.000Z",
    });
    expect(missing.status).toBe(200);
    const missingBody = (await missing.json()) as {
      scoresFromSnapshot: boolean;
      funnel: { gateReasons: string[] };
    };
    expect(missingBody.scoresFromSnapshot).toBe(true);
    expect(missingBody.funnel.gateReasons).toContain("no_snapshot");
  });

  it("finding 5: backdated assignment created later does not rewrite past dataAsOf", async () => {
    const population = buildPassingPopulation();
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      finishedAt: new Date("2026-04-01T12:00:00.000Z"),
    });
    await seedFunnelPopulation(
      db.pool,
      account,
      population,
      syncRunId,
      new Date("2026-04-01T12:00:00.000Z"),
    );

    const purchase = await createConversionMetric(db.pool, {
      tenantId: db.tenantId,
      input: {
        label: "Purchase",
        numeratorActionTypes: ["offsite_conversion.fb_pixel_purchase"],
        numeratorAggregation: "first_present",
        denominator: "link_clicks",
        valueSource: "meta_value",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
      },
    });
    await assignMetricToAdAccount(db.pool, {
      tenantId: db.tenantId,
      metaAdAccountId: account.accountId,
      conversionMetricId: purchase.id,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });

    // Freeze created_at of the April-known assignment into the past.
    await db.pool.query(
      `UPDATE ad_account_metric_assignment
       SET created_at = '2026-03-01T00:00:00.000Z'
       WHERE meta_ad_account_id = $1`,
      [account.accountId],
    );
    await db.pool.query(
      `UPDATE conversion_metric
       SET created_at = '2026-03-01T00:00:00.000Z'
       WHERE id = $1`,
      [purchase.id],
    );

    const april = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: "2026-04-01T12:00:00.000Z",
    });
    expect(april.metricDefinition.label).toBe("Purchase");

    const lead = await createConversionMetric(db.pool, {
      tenantId: db.tenantId,
      input: {
        label: "Lead",
        numeratorActionTypes: ["offsite_conversion.fb_pixel_lead"],
        numeratorAggregation: "first_present",
        denominator: "link_clicks",
        valueSource: "none",
        effectiveFrom: "2026-02-01T00:00:00.000Z",
      },
    });
    await assignMetricToAdAccount(db.pool, {
      tenantId: db.tenantId,
      metaAdAccountId: account.accountId,
      conversionMetricId: lead.id,
      effectiveFrom: "2026-02-01T00:00:00.000Z",
    });
    // July creation — even with backdated effectiveFrom.
    await db.pool.query(
      `UPDATE ad_account_metric_assignment
       SET created_at = '2026-07-15T00:00:00.000Z'
       WHERE conversion_metric_id = $1`,
      [lead.id],
    );
    await db.pool.query(
      `UPDATE conversion_metric
       SET created_at = '2026-07-15T00:00:00.000Z'
       WHERE id = $1`,
      [lead.id],
    );

    // Append-only: prior Purchase row was never UPDATEd.
    const versions = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM conversion_metric WHERE tenant_id = $1`,
      [db.tenantId],
    );
    expect(Number(versions.rows[0]!.n)).toBeGreaterThanOrEqual(2);

    const stillApril = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: "2026-04-01T12:00:00.000Z",
    });
    expect(stillApril.metricDefinition.label).toBe("Purchase");
  });

  it("finding 6: duplicate numerator action types rejected by Zod and DB", async () => {
    const parsed = CreateConversionMetricSchema.safeParse({
      label: "Dup",
      numeratorActionTypes: ["lead", "lead"],
      numeratorAggregation: "sum_disjoint",
      valueSource: "none",
    });
    expect(parsed.success).toBe(false);

    // Aggregation would otherwise double-count.
    const doubled = aggregateNumerator(
      [{ actionType: "lead", present: true, count: 5, value: 0 }],
      ["lead", "lead"],
      "sum_disjoint",
    );
    expect(doubled.count).toBe(10);

    await expect(
      db.pool.query(
        `INSERT INTO conversion_metric (
           id, tenant_id, label, version, numerator_action_types,
           numerator_aggregation, attribution_spec, denominator,
           value_source, fixed_value, currency, effective_from
         ) VALUES (
           $1, $2, 'Dup', 1, ARRAY['lead','lead'], 'sum_disjoint',
           ARRAY['1d_view','7d_click'], NULL, 'none', NULL, NULL, now()
         )`,
        [uuidv7(), db.tenantId],
      ),
    ).rejects.toThrow(/conversion_metric_numerator_action_types_unique|check/i);
  });

  it("finding 7: snapshot job binds sync to account; family is API-internal", async () => {
    const other = await seedMetaAccount(db.pool, db.tenantId, "USD");
    const syncA = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
    });
    const sync = await db.pool.query<{ meta_ad_account_id: string }>(
      `SELECT meta_ad_account_id
       FROM insight_sync_run
       WHERE id = $1 AND tenant_id = $2`,
      [syncA, db.tenantId],
    );
    expect(sync.rows[0]?.meta_ad_account_id).toBe(account.accountId);
    expect(sync.rows[0]?.meta_ad_account_id).not.toBe(other.accountId);

    // Drive the real handler with a mismatched account — must refuse.
    const ctx: JobContext<{
      metaAdAccountId: string;
      syncRunId: string;
      windowEnd: string;
    }> = {
      input: {
        metaAdAccountId: other.accountId,
        syncRunId: syncA,
        windowEnd: "2026-07-19",
      },
      tenantId: db.tenantId,
      signal: new AbortController().signal,
      progress: async () => {},
      withLease: async () => ({ acquired: false }),
      isCancelled: () => false,
    };
    await expect(metricSnapshotComputeFamily.handler(ctx)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof HandlerError &&
        err.code === "SYNC_ACCOUNT_MISMATCH" &&
        err.message === "sync_account_mismatch" &&
        err.retryable === false,
    );

    // Public POST /api/runs must not start this family.
    const routeSource = await import("@/app/api/runs/route");
    expect(routeSource.POST.toString()).toContain("metric_snapshot_compute");
    expect(routeSource.POST.toString()).toContain("family_internal_only");
  });

  it("finding 8: cumulative and half-window rows coexist under same bounds", async () => {
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-07-05",
      windowEnd: "2026-07-19",
    });
    const observedAt = new Date("2026-07-20T12:00:00.000Z");
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "half-cum",
      windowStart: "2026-07-05",
      windowEnd: "2026-07-19",
      reach: 600,
      frequency: 1.4,
      isCumulative: false,
      observedAt,
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "half-cum",
      windowStart: "2026-07-05",
      windowEnd: "2026-07-19",
      reach: 5000,
      frequency: 2,
      isCumulative: true,
      observedAt,
    });

    const rows = await db.pool.query<{
      is_cumulative: boolean;
      reach: string;
    }>(
      `SELECT is_cumulative, reach::text
       FROM insight_window_as_of($1, $2::timestamptz)
       WHERE meta_ad_id = 'half-cum'
         AND window_start = '2026-07-05'
         AND window_end = '2026-07-19'
       ORDER BY is_cumulative`,
      [db.tenantId, "2026-07-20T12:00:00.000Z"],
    );
    expect(rows.rows).toEqual([
      { is_cumulative: false, reach: "600" },
      { is_cumulative: true, reach: "5000" },
    ]);
  });

  it("finding 9: missing ad observation makes account numerator null", async () => {
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
    });
    const observedAt = new Date("2026-07-20T12:00:00.000Z");
    await seedDailyRows(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      observedAt,
      rows: [
        {
          metaAdId: "A",
          date: "2026-07-19",
          spend: 50,
          impressions: 1000,
          clicks: 50,
          linkClicks: 50,
          actions: [
            {
              actionType: "offsite_conversion.fb_pixel_purchase",
              count: 5,
              value: 100,
            },
          ],
        },
        {
          metaAdId: "B",
          date: "2026-07-19",
          spend: 50,
          impressions: 1000,
          clicks: 50,
          linkClicks: 50,
          // no conversion observation
        },
      ],
    });
    for (const metaAdId of ["A", "B"]) {
      await seedWindow(db.pool, {
        tenantId: db.tenantId,
        syncRunId,
        metaAdId,
        windowStart: "2026-07-19",
        windowEnd: "2026-07-19",
        reach: 500,
        frequency: 1.2,
        observedAt,
      });
    }

    const metric = await createConversionMetric(db.pool, {
      tenantId: db.tenantId,
      input: {
        label: "Purchase",
        numeratorActionTypes: ["offsite_conversion.fb_pixel_purchase"],
        numeratorAggregation: "first_present",
        denominator: "clicks",
        valueSource: "none",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
      },
    });
    await assignMetricToAdAccount(db.pool, {
      tenantId: db.tenantId,
      metaAdAccountId: account.accountId,
      conversionMetricId: metric.id,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    await backdateMetricCreatedAt(db.pool, {
      metricIds: [metric.id],
      metaAdAccountId: account.accountId,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const resolved = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
      dataAsOf: "2026-07-20T12:00:00.000Z",
    });
    expect(resolved.accountTotals.numerator).toBeNull();
    expect(resolved.accountTotals.numeratorReason).toBe("missing_observations");
    expect(resolved.accountTotals.cvr).toBeNull();
    expect(resolved.gateReasons).toContain("missing_observations");
  });

  it("finding 10: account reach/frequency come from account window, not ad sums", async () => {
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
    });
    const observedAt = new Date("2026-07-20T12:00:00.000Z");
    await seedDailyRows(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      observedAt,
      rows: [
        {
          metaAdId: "acc-1",
          date: "2026-07-19",
          spend: 10,
          impressions: 100,
        },
      ],
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "acc-1",
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
      reach: 50,
      frequency: 1.1,
      observedAt,
    });
    await seedAccountWindow(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      syncRunId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
      reach: 10_000,
      frequency: 2.1,
      observedAt,
    });

    const resolved = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
      dataAsOf: "2026-07-20T12:00:00.000Z",
    });
    expect(resolved.accountTotals.reach).toBe(10_000);
    expect(resolved.accountTotals.frequency).toBe(2.1);
  });
});
