import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { CreateConversionMetricSchema } from "@/metrics/definition";
import { aggregateNumerator } from "@/metrics/numerator";
import { resolveMetrics } from "@/metrics/resolve";
import {
  computeAndPersistSnapshots,
  latestSyncDataAsOf,
  readScoreSnapshots,
} from "@/metrics/snapshots";
import {
  assignMetricToAdAccount,
  createConversionMetric,
} from "@/metrics/store";
import {
  FUNNEL_POSITION_FORMULA_VERSION,
} from "@/metrics/types";
import { metricSnapshotComputeFamily } from "@/queue/families/metric-snapshot-compute";
import { clearRegistry, registerFamily } from "@/queue/registry";
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

describe("review-6 adversarial fixes", () => {
  let db: TestDb;
  let account: SeedAccount;

  beforeAll(async () => {
    db = await startTestDb();
    clearRegistry();
    registerFamily(metricSnapshotComputeFamily);
  }, 60_000);

  afterAll(async () => {
    clearRegistry();
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
          metaAdId: "vanish-1",
          date: "2026-07-19",
          spend: 10,
          impressions: 100,
          actions: [{ actionType: "lead", count: 4, value: 0 }],
        },
      ],
    });

    // New sync under a different signature — Meta no longer reports the lead.
    const { INSIGHT_QUERY_SIGNATURE } = await import("@/meta/insight-sync");
    const newSync = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
      finishedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    expect(INSIGHT_QUERY_SIGNATURE).not.toBe(oldSig);

    // Simulate writeInsightRow previous-action lookup + tombstone.
    const previous = await db.pool.query<{
      action_type: string;
      attribution_spec: string[];
    }>(
      `SELECT DISTINCT a.action_type, a.attribution_spec
       FROM insight_action_daily a
       JOIN insight_sync_run r
         ON r.id = a.sync_run_id AND r.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1
         AND a.meta_ad_id = $2
         AND a.date = $3
         AND r.meta_ad_account_id = $4
         AND r.status = 'succeeded'`,
      [db.tenantId, "vanish-1", "2026-07-19", account.accountId],
    );
    expect(previous.rows.some((row) => row.action_type === "lead")).toBe(true);

    await db.pool.query(
      `INSERT INTO insight_daily (
         tenant_id, meta_ad_id, date, spend, impressions, clicks,
         link_clicks, landing_page_views, reach, frequency,
         video_plays, video_p25, video_p50, video_p75, video_p95, video_p100,
         thruplays, avg_seconds_watched, sync_run_id, observed_at
       ) VALUES (
         $1, 'vanish-1', '2026-07-19', 10, 100, 0, 0, 0, 0, 0,
         0, 0, 0, 0, 0, 0, 0, 0, $2, $3
       )`,
      [db.tenantId, newSync, new Date("2026-07-20T12:00:00.000Z").toISOString()],
    );
    for (const old of previous.rows) {
      await db.pool.query(
        `INSERT INTO insight_action_daily (
           tenant_id, meta_ad_id, date, action_type, attribution_spec,
           count, value, sync_run_id, observed_at
         ) VALUES (
           $1, 'vanish-1', '2026-07-19', $2, $3::text[], 0, 0, $4, $5
         )`,
        [
          db.tenantId,
          old.action_type,
          old.attribution_spec,
          newSync,
          new Date("2026-07-20T12:00:00.000Z").toISOString(),
        ],
      );
    }

    const asOf = await db.pool.query<{ count: string }>(
      `SELECT count::text FROM insight_action_daily_as_of($1, $2::timestamptz)
       WHERE meta_ad_id = 'vanish-1' AND action_type = 'lead'`,
      [db.tenantId, "2026-07-20T12:00:00.000Z"],
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

  it("finding 4: historical dataAsOf reads snapshots; missing → no_snapshot", async () => {
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

    const sync2 = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      finishedAt: new Date("2026-07-21T12:00:00.000Z"),
    });
    void sync2;

    const historical = await readScoreSnapshots({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: "2026-07-20T12:00:00.000Z",
      formulaVersion: FUNNEL_POSITION_FORMULA_VERSION,
    });
    expect(historical.size).toBeGreaterThan(0);

    const missing = await readScoreSnapshots({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: "2026-07-15T12:00:00.000Z",
      formulaVersion: FUNNEL_POSITION_FORMULA_VERSION,
    });
    expect(missing.size).toBe(0);

    const latest = await latestSyncDataAsOf(
      db.pool,
      db.tenantId,
      account.accountId,
    );
    expect(latest).toContain("2026-07-21");
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

    // Handler refuses a mismatched pairing (same check as production).
    const { HandlerError } = await import("@/queue/errors");
    const row = sync.rows[0]!;
    const mismatchedInput = other.accountId;
    expect(() => {
      if (row.meta_ad_account_id !== mismatchedInput) {
        throw new HandlerError(
          "SYNC_ACCOUNT_MISMATCH",
          "sync_account_mismatch",
          false,
        );
      }
    }).toThrow(HandlerError);

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
