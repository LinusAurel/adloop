import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { assertSumDisjointAllowed, MetricConfigError } from "@/metrics/action-overlaps";
import { aggregateNumerator } from "@/metrics/numerator";
import { computeFunnelPosition } from "@/metrics/funnel-position";
import {
  computeExpectedValueRoas,
  computeMetaRoas,
} from "@/metrics/roas";
import { resolveMetrics, type PerAdBaseMetrics } from "@/metrics/resolve";
import { computeAndPersistSnapshots } from "@/metrics/snapshots";
import {
  assignMetricToAdAccount,
  createConversionMetric,
  createConversionMetricVersion,
} from "@/metrics/store";
import { splitWindowHalves } from "@/metrics/creative-strain";
import { creativeStrainV1 } from "@/metrics/score-config/creative-strain-v1";
import { FALLBACK_PURCHASE_METRIC } from "@/metrics/definition";
import type { TestDb } from "./db-harness";
import { startTestDb } from "./db-harness";
import {
  backdateMetricCreatedAt,
  buildPassingPopulation,
  seedDailyRows,
  seedFunnelPopulation,
  seedMetaAccount,
  seedSucceededSync,
  seedWindow,
  type SeedAccount,
} from "./metrics-fixtures";

describe("stage 3 metric model", () => {
  let db: TestDb;
  let account: SeedAccount;

  beforeAll(async () => {
    db = await startTestDb();
  }, 60_000);

  afterAll(async () => {
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

  it("case 9: rejects sum_disjoint with overlapping action types", () => {
    expect(() =>
      assertSumDisjointAllowed([
        "omni_purchase",
        "offsite_conversion.fb_pixel_purchase",
      ]),
    ).toThrow(MetricConfigError);
  });

  it("case 10: coalesce_aliases counts once across purchase aliases", () => {
    const aggregated = aggregateNumerator(
      [
        {
          actionType: "omni_purchase",
          present: true,
          count: 3,
          value: 90,
        },
        {
          actionType: "offsite_conversion.fb_pixel_purchase",
          present: true,
          count: 3,
          value: 90,
        },
      ],
      ["omni_purchase", "offsite_conversion.fb_pixel_purchase"],
      "coalesce_aliases",
    );
    expect(aggregated.count).toBe(3);
    expect(aggregated.value).toBe(90);
  });

  it("case 7: spend <= 0 yields null ROAS with no_spend", () => {
    const result = computeMetaRoas({
      spend: 0,
      metaValue: 100,
      numeratorCount: 2,
      valueSource: "meta_value",
      fixedValue: null,
      fixedCurrency: null,
      accountCurrency: "EUR",
      attributionSpec: ["1d_view", "7d_click"],
      dataAsOf: new Date("2026-07-20T12:00:00.000Z"),
    });
    expect(result.value).toBeNull();
    expect(result.reason).toBe("no_spend");
  });

  it("case 8: currency mismatch yields null expected_value_roas", () => {
    const result = computeExpectedValueRoas({
      spend: 100,
      metaValue: null,
      numeratorCount: 2,
      valueSource: "fixed",
      fixedValue: 45,
      fixedCurrency: "USD",
      accountCurrency: "EUR",
      attributionSpec: ["1d_view", "7d_click"],
      dataAsOf: new Date("2026-07-20T12:00:00.000Z"),
    });
    expect(result.value).toBeNull();
    expect(result.reason).toBe("currency_mismatch");
  });

  it("creative strain: clips extreme changes and renormalizes weights via production path", async () => {
    const { clipRelativeChange, computeCreativeStrain } = await import(
      "@/metrics/creative-strain"
    );
    expect(clipRelativeChange(3)).toBe(1);
    expect(clipRelativeChange(-3)).toBe(0);

    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-06-20",
      windowEnd: "2026-07-19",
      finishedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    const observedAt = new Date("2026-07-20T12:00:00.000Z");
    // Identical CTR both halves (ctrDecay=0 → clip 0.5). Extreme frequency
    // jump (1→5 → relative 4 → clip 1). Half-A net-new share is 0 so
    // reach-decay is null and remaining weights renormalize to 75.
    for (const date of [
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
      "2026-07-05",
      "2026-07-06",
      "2026-07-07",
    ]) {
      await seedDailyRows(db.pool, {
        tenantId: db.tenantId,
        syncRunId,
        observedAt,
        rows: [
          {
            metaAdId: "strain-clip",
            date,
            spend: 20,
            impressions: 1000,
            clicks: 50,
          },
        ],
      });
    }
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "strain-clip",
      windowStart: "2026-06-20",
      windowEnd: "2026-07-04",
      reach: 1000,
      frequency: 1,
      observedAt,
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "strain-clip",
      windowStart: "2026-07-05",
      windowEnd: "2026-07-19",
      reach: 1000,
      frequency: 5,
      observedAt,
    });
    // Cumulative: half A net-new = 0; half B has positive net-new.
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "strain-clip",
      windowStart: "2026-01-01",
      windowEnd: "2026-06-19",
      reach: 4000,
      frequency: 1.5,
      isCumulative: true,
      observedAt,
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "strain-clip",
      windowStart: "2026-01-01",
      windowEnd: "2026-07-04",
      reach: 4000, // net-new half A = 0
      frequency: 1.6,
      isCumulative: true,
      observedAt,
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "strain-clip",
      windowStart: "2026-01-01",
      windowEnd: "2026-07-19",
      reach: 4500,
      frequency: 2,
      isCumulative: true,
      observedAt,
    });

    const result = await computeCreativeStrain({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: "2026-06-20",
      windowEnd: "2026-07-19",
      dataAsOf: "2026-07-20T12:00:00.000Z",
      metaAdIds: ["strain-clip"],
    });
    expect(result.ads[0]?.gateStatus).toBe("ok");
    expect(result.ads[0]?.components.frequencyTrend).toBe(4);
    expect(result.ads[0]?.components.ctrDecay).toBeCloseTo(0, 10);
    expect(result.ads[0]?.components.netNewReachDecay).toBeNull();
    expect(result.ads[0]?.value).toBeCloseTo(75, 5);
  });

  it("creative strain: half-window split is stable", () => {
    const halves = splitWindowHalves("2026-06-20", "2026-07-19");
    expect(halves.halfA).toEqual({ start: "2026-06-20", end: "2026-07-04" });
    expect(halves.halfB).toEqual({ start: "2026-07-05", end: "2026-07-19" });
    expect(creativeStrainV1.minDaysPerHalf).toBe(3);
  });

  it("case 3: population of 7 is insufficient_data / population_too_small", () => {
    const rows = syntheticPopulation(7);
    const result = computeFunnelPosition({
      rows,
      metricDefinition: {
        ...FALLBACK_PURCHASE_METRIC,
        denominator: "link_clicks",
      },
      accountCurrency: "EUR",
    });
    expect(result.gateStatus).toBe("insufficient_data");
    expect(result.gateReasons).toContain("population_too_small");
  });

  it("case 4: identical ads yield no_variance without NaN", () => {
    const rows = syntheticPopulation(8, { identical: true });
    const result = computeFunnelPosition({
      rows,
      metricDefinition: {
        ...FALLBACK_PURCHASE_METRIC,
        denominator: "link_clicks",
      },
      accountCurrency: "EUR",
    });
    expect(result.gateStatus).toBe("insufficient_data");
    expect(result.gateReasons).toContain("no_variance");
    for (const ad of result.ads) {
      expect(ad.score).toBeNull();
      expect(Number.isNaN(ad.score as number)).toBe(false);
    }
  });

  it("case 5/6: zero denominator or reach excludes the ad from population", () => {
    const rows = syntheticPopulation(8);
    rows[0]!.denominator = 0;
    rows[0]!.cvr = null;
    rows[1]!.reach = 0;
    const result = computeFunnelPosition({
      rows,
      metricDefinition: {
        ...FALLBACK_PURCHASE_METRIC,
        denominator: "link_clicks",
      },
      accountCurrency: "EUR",
    });
    expect(result.populationSize).toBe(6);
    expect(result.ads.find((ad) => ad.metaAdId === rows[0]!.metaAdId)?.gateReasons).toContain(
      "zero_denominator",
    );
    expect(result.ads.find((ad) => ad.metaAdId === rows[1]!.metaAdId)?.gateReasons).toContain(
      "zero_reach",
    );
  });

  it("case 2: more net_new_reach moves that ad toward Prospector", () => {
    const beforeRows = syntheticPopulation(8);
    const afterRows = beforeRows.map((row, index) =>
      index === 0
        ? {
            ...row,
            netNewReach: (row.netNewReach ?? 0) + 500,
            // keep reach fixed so share rises
          }
        : row,
    );
    const metric = {
      ...FALLBACK_PURCHASE_METRIC,
      denominator: "link_clicks" as const,
    };
    const before = computeFunnelPosition({
      rows: beforeRows,
      metricDefinition: metric,
      accountCurrency: "EUR",
    });
    const after = computeFunnelPosition({
      rows: afterRows,
      metricDefinition: metric,
      accountCurrency: "EUR",
    });
    const beforeScore = before.ads.find((ad) => ad.metaAdId === beforeRows[0]!.metaAdId)?.score;
    const afterScore = after.ads.find((ad) => ad.metaAdId === afterRows[0]!.metaAdId)?.score;
    expect(beforeScore).not.toBeNull();
    expect(afterScore).not.toBeNull();
    expect(afterScore!).toBeLessThanOrEqual(beforeScore!);
  });

  it("case 12: only-null CVR component does not invent Prospector", () => {
    const rows = syntheticPopulation(8, { identical: true, nullCvrOnly: true });
    const result = computeFunnelPosition({
      rows,
      metricDefinition: {
        ...FALLBACK_PURCHASE_METRIC,
        denominator: "link_clicks",
        valueSource: "none",
      },
      accountCurrency: "EUR",
    });
    expect(result.gateStatus).toBe("insufficient_data");
    expect(result.ads.every((ad) => ad.band === null)).toBe(true);
  });

  it("case 11: metric without denominator returns count and CPA, no CVR error", async () => {
    const population = buildPassingPopulation();
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
    });
    await seedFunnelPopulation(db.pool, account, population, syncRunId);

    const metric = await createConversionMetric(db.pool, {
      tenantId: db.tenantId,
      input: {
        label: "Purchases count-only",
        numeratorActionTypes: ["offsite_conversion.fb_pixel_purchase"],
        numeratorAggregation: "coalesce_aliases",
        denominator: null,
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
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(resolved.metricDefinition.denominator).toBeNull();
    expect(resolved.rows.some((row) => row.numerator !== null)).toBe(true);
    expect(resolved.rows.every((row) => row.cvr === null)).toBe(true);
    expect(resolved.gateStatus).toBe("ok");
  });

  it("cases 1 and 14: metric switch leaves raw data intact and old windowEnd keeps old definition", async () => {
    const population = buildPassingPopulation();
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      finishedAt: new Date("2026-07-10T12:00:00.000Z"),
    });
    await seedFunnelPopulation(db.pool, account, population, syncRunId);

    const purchase = await createConversionMetric(db.pool, {
      tenantId: db.tenantId,
      input: {
        label: "Purchase",
        numeratorActionTypes: ["offsite_conversion.fb_pixel_purchase"],
        numeratorAggregation: "coalesce_aliases",
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
    await backdateMetricCreatedAt(db.pool, {
      metricIds: [purchase.id],
      metaAdAccountId: account.accountId,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const beforeSwitch = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: new Date("2026-07-15T00:00:00.000Z"),
    });
    expect(beforeSwitch.metricDefinition.label).toBe("Purchase");
    const purchaseCount = beforeSwitch.accountTotals.numerator;

    const switchAt = "2026-07-20T00:00:00.000Z";
    const lead = await createConversionMetric(db.pool, {
      tenantId: db.tenantId,
      input: {
        label: "Lead",
        numeratorActionTypes: ["offsite_conversion.fb_pixel_lead"],
        numeratorAggregation: "coalesce_aliases",
        denominator: "link_clicks",
        valueSource: "fixed",
        fixedValue: 45,
        currency: "EUR",
        effectiveFrom: switchAt,
      },
    });
    await assignMetricToAdAccount(db.pool, {
      tenantId: db.tenantId,
      metaAdAccountId: account.accountId,
      conversionMetricId: lead.id,
      effectiveFrom: switchAt,
    });
    await backdateMetricCreatedAt(db.pool, {
      metricIds: [lead.id],
      metaAdAccountId: account.accountId,
      createdAt: switchAt,
    });

    // Raw action rows unchanged.
    const raw = await db.pool.query<{ action_type: string; count: string }>(
      `SELECT action_type, count::text
       FROM insight_action_daily
       WHERE tenant_id = $1
       ORDER BY action_type, meta_ad_id`,
      [db.tenantId],
    );
    expect(
      raw.rows.every(
        (row) => row.action_type === "offsite_conversion.fb_pixel_purchase",
      ),
    ).toBe(true);

    // Old windowEnd still resolves the Purchase assignment.
    const historical = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(historical.metricDefinition.label).toBe("Purchase");
    expect(historical.metricDefinition.id).toBe(purchase.id);
    expect(historical.accountTotals.numerator).toBe(purchaseCount);

    // A window ending after the switch uses Lead (no lead rows → null/0 count).
    const after = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: "2026-07-01",
      windowEnd: "2026-07-25",
      dataAsOf: new Date("2026-07-26T00:00:00.000Z"),
    });
    expect(after.metricDefinition.label).toBe("Lead");
    expect(after.metricDefinition.id).toBe(lead.id);
  });

  it("case 13: second snapshot compute inserts new rows and leaves old unchanged", async () => {
    const population = buildPassingPopulation();
    const sync1 = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      finishedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    await seedFunnelPopulation(db.pool, account, population, sync1);

    const first = await computeAndPersistSnapshots({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: new Date("2026-07-20T12:00:00.000Z"),
      sourceSyncRunIds: [sync1],
    });
    expect(first.funnelSnapshotIds.length).toBeGreaterThan(0);

    const before = await db.pool.query<{
      id: string;
      value: string | null;
      computed_at: Date;
    }>(
      `SELECT id, value::text, computed_at
       FROM metric_snapshot
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [first.funnelSnapshotIds],
    );

    const sync2 = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      finishedAt: new Date("2026-07-21T12:00:00.000Z"),
    });
    // Touch observations so the second data_as_of can see them.
    await db.pool.query(
      `UPDATE insight_daily SET observed_at = $1 WHERE sync_run_id = $2`,
      [new Date("2026-07-21T11:00:00.000Z").toISOString(), sync1],
    );
    await db.pool.query(
      `UPDATE insight_window SET observed_at = $1 WHERE sync_run_id = $2`,
      [new Date("2026-07-21T11:00:00.000Z").toISOString(), sync1],
    );

    const second = await computeAndPersistSnapshots({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: population.windowStart,
      windowEnd: population.windowEnd,
      dataAsOf: new Date("2026-07-21T12:00:00.000Z"),
      sourceSyncRunIds: [sync2],
    });
    expect(second.funnelSnapshotIds.length).toBeGreaterThan(0);
    expect(
      second.funnelSnapshotIds.some((id) => first.funnelSnapshotIds.includes(id)),
    ).toBe(false);

    const after = await db.pool.query<{
      id: string;
      value: string | null;
      computed_at: Date;
    }>(
      `SELECT id, value::text, computed_at
       FROM metric_snapshot
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [first.funnelSnapshotIds],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("missing meta action_values stay NULL and do not become zero ROAS", async () => {
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
      finishedAt: new Date("2026-07-10T12:00:00.000Z"),
    });
    await seedDailyRows(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      observedAt: new Date("2026-07-10T12:00:00.000Z"),
      rows: [
        {
          metaAdId: "9001",
          date: "2026-07-19",
          spend: 100,
          impressions: 2000,
          linkClicks: 50,
          actions: [
            {
              actionType: "offsite_conversion.fb_pixel_purchase",
              count: 2,
              value: null,
            },
          ],
        },
      ],
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "9001",
      windowStart: "2026-07-19",
      windowEnd: "2026-07-19",
      reach: 1000,
      frequency: 1.5,
      observedAt: new Date("2026-07-10T12:00:00.000Z"),
    });

    const metric = await createConversionMetric(db.pool, {
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
      dataAsOf: new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(resolved.rows[0]?.metaValue).toBeNull();
    expect(resolved.rows[0]?.metaRoas.value).toBeNull();
    expect(resolved.rows[0]?.metaRoas.reason).toBe("missing_meta_value");
  });

  it("metric versions are append-only", async () => {
    const first = await createConversionMetric(db.pool, {
      tenantId: db.tenantId,
      input: {
        label: "Lead",
        numeratorActionTypes: ["offsite_conversion.fb_pixel_lead"],
        numeratorAggregation: "coalesce_aliases",
        denominator: "link_clicks",
        valueSource: "none",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
      },
    });
    const second = await createConversionMetricVersion(db.pool, {
      tenantId: db.tenantId,
      metricId: first.id,
      input: {
        label: "Lead v2",
        numeratorActionTypes: ["lead"],
        numeratorAggregation: "first_present",
        denominator: null,
        valueSource: "none",
        effectiveFrom: "2026-06-01T00:00:00.000Z",
      },
    });
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    const versions = await db.pool.query<{ version: number; label: string }>(
      `SELECT version, label FROM conversion_metric
       WHERE tenant_id = $1 AND id = $2 ORDER BY version`,
      [db.tenantId, first.id],
    );
    expect(versions.rows).toEqual([
      { version: 1, label: "Lead" },
      { version: 2, label: "Lead v2" },
    ]);
  });

  it("attribution_not_synced when metric asks for an unsynced set", async () => {
    const metric = await createConversionMetric(db.pool, {
      tenantId: db.tenantId,
      input: {
        label: "1d click only",
        numeratorActionTypes: ["purchase"],
        numeratorAggregation: "first_present",
        attributionSpec: ["1d_click"],
        denominator: null,
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
      windowStart: "2026-06-20",
      windowEnd: "2026-07-19",
      dataAsOf: new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(resolved.gateStatus).toBe("insufficient_data");
    expect(resolved.gateReasons).toContain("attribution_not_synced");
    expect(resolved.rows).toEqual([]);
  });

  it("creative strain: window_too_short when a half lacks delivery days", async () => {
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-06-20",
      windowEnd: "2026-07-19",
      finishedAt: new Date("2026-07-10T12:00:00.000Z"),
    });
    await seedDailyRows(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      observedAt: new Date("2026-07-10T12:00:00.000Z"),
      rows: [
        {
          metaAdId: "strain-1",
          date: "2026-06-21",
          spend: 10,
          impressions: 100,
          clicks: 5,
        },
        {
          metaAdId: "strain-1",
          date: "2026-06-22",
          spend: 10,
          impressions: 100,
          clicks: 5,
        },
        {
          metaAdId: "strain-1",
          date: "2026-07-10",
          spend: 20,
          impressions: 200,
          clicks: 8,
        },
        {
          metaAdId: "strain-1",
          date: "2026-07-11",
          spend: 20,
          impressions: 200,
          clicks: 8,
        },
        {
          metaAdId: "strain-1",
          date: "2026-07-12",
          spend: 20,
          impressions: 200,
          clicks: 8,
        },
      ],
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "strain-1",
      windowStart: "2026-06-20",
      windowEnd: "2026-07-04",
      reach: 500,
      frequency: 1.1,
      observedAt: new Date("2026-07-10T12:00:00.000Z"),
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: "strain-1",
      windowStart: "2026-07-05",
      windowEnd: "2026-07-19",
      reach: 600,
      frequency: 1.4,
      observedAt: new Date("2026-07-10T12:00:00.000Z"),
    });

    const { computeCreativeStrain } = await import("@/metrics/creative-strain");
    const result = await computeCreativeStrain({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart: "2026-06-20",
      windowEnd: "2026-07-19",
      dataAsOf: new Date("2026-07-15T00:00:00.000Z"),
      metaAdIds: ["strain-1"],
    });
    expect(result.ads[0]?.gateStatus).toBe("insufficient_data");
    expect(result.ads[0]?.gateReasons).toContain("window_too_short");
    expect(result.ads[0]?.value).toBeNull();
  });
});

function syntheticPopulation(
  size: number,
  options?: { identical?: boolean; nullCvrOnly?: boolean },
): PerAdBaseMetrics[] {
  return Array.from({ length: size }, (_, index) => {
    const spend = options?.identical ? 100 : 80 + index * 10;
    const impressions = options?.identical ? 2000 : 2000 + index * 200;
    const linkClicks = options?.identical ? 100 : 80 + index * 15;
    const reach = options?.identical ? 1000 : 900 + index * 40;
    const netNewReach = options?.identical ? 500 : 300 + index * 50;
    const conversions = options?.nullCvrOnly
      ? null
      : options?.identical
        ? 2
        : index;
    const value = options?.nullCvrOnly
      ? null
      : options?.identical
        ? 80
        : index * 40;
    const denominator = linkClicks;
    const cvr =
      options?.nullCvrOnly || conversions === null
        ? null
        : conversions / denominator;
    const dataAsOf = new Date("2026-07-20T12:00:00.000Z");
    const roasInput = {
      spend,
      metaValue: value,
      numeratorCount: conversions,
      valueSource: "meta_value" as const,
      fixedValue: null,
      fixedCurrency: null,
      accountCurrency: "EUR",
      attributionSpec: ["1d_view", "7d_click"],
      dataAsOf,
    };
    return {
      metaAdId: `ad-${index}`,
      spend,
      impressions,
      clicks: linkClicks + 5,
      linkClicks,
      landingPageViews: Math.floor(linkClicks * 0.6),
      reach,
      frequency: 1.4,
      windowSynced: true,
      netNewReach,
      netNewReachReason: null,
      numerator: conversions,
      metaValue: value,
      denominator,
      cvr,
      cpa:
        conversions !== null && conversions > 0 ? spend / conversions : null,
      valuePerImpression:
        value === null || impressions <= 0 ? null : value / impressions,
      metaRoas: computeMetaRoas(roasInput),
      expectedValueRoas: computeExpectedValueRoas({
        ...roasInput,
        valueSource: "none",
      }),
      realizedValueRoas: {
        value: null,
        valueSource: "none",
        currency: "EUR",
        attributionSpec: ["1d_view", "7d_click"],
        dataAsOf: dataAsOf.toISOString(),
        reason: "value_source_none",
      },
      syncRunIds: [uuidv7()],
      windowComplete: true,
      missingDateRange: null,
    };
  });
}
