import type { Queryable } from "@/db/queryable";
import {
  FALLBACK_PURCHASE_METRIC,
  toMetricDefinitionInfo,
  type MetricDefinitionInfo,
  type StoredMetricRow,
} from "./definition";
import {
  dataAsOfCutoff,
  eachDateInclusive,
  firstMissingDateRange,
  type DataAsOf,
  type MissingDateRange,
} from "./data-as-of";
import { aggregateNumerator, type ActionObservation } from "./numerator";
import {
  computeExpectedValueRoas,
  computeMetaRoas,
  realizedValueRoasPlaceholder,
  attributionIsSynced,
  type RoasResult,
} from "./roas";
import type { DenominatorField, GateReason, GateStatus } from "./types";

export interface ResolveMetricsParams {
  pool: Queryable;
  tenantId: string;
  adAccountId: string;
  windowStart: string;
  windowEnd: string;
  dataAsOf: DataAsOf;
}

export interface PerAdBaseMetrics {
  metaAdId: string;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  landingPageViews: number;
  /** Window reach from insight_window — never summed from daily rows. */
  reach: number | null;
  frequency: number | null;
  windowSynced: boolean;
  netNewReach: number | null;
  netNewReachReason: GateReason | null;
  numerator: number | null;
  metaValue: number | null;
  denominator: number | null;
  cvr: number | null;
  cpa: number | null;
  valuePerImpression: number | null;
  metaRoas: RoasResult;
  expectedValueRoas: RoasResult;
  realizedValueRoas: RoasResult;
  syncRunIds: string[];
  /** Per-ad day coverage for the requested window. */
  windowComplete: boolean;
  missingDateRange: MissingDateRange | null;
}

export interface AccountTotals {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  landingPageViews: number;
  /** From insight_account_window — never summed from ads. */
  reach: number | null;
  frequency: number | null;
  numerator: number | null;
  /** Set when numerator is null because at least one ad lacks observations. */
  numeratorReason: GateReason | null;
  denominator: number | null;
  cvr: number | null;
  cpa: number | null;
  metaRoas: RoasResult;
  expectedValueRoas: RoasResult;
  realizedValueRoas: RoasResult;
}

export interface ResolveMetricsResult {
  rows: PerAdBaseMetrics[];
  accountTotals: AccountTotals;
  metricDefinition: MetricDefinitionInfo;
  accountCurrency: string;
  gateStatus: GateStatus;
  gateReasons: GateReason[];
  /** Present when gateReasons includes window_incomplete. */
  missingDateRange: MissingDateRange | null;
}

interface DailyAggRow {
  meta_ad_id: string;
  spend: string;
  impressions: string;
  clicks: string;
  link_clicks: string;
  landing_page_views: string;
  sync_run_ids: string[];
}

interface DailyDateRow {
  meta_ad_id: string;
  date: string;
}

interface WindowRow {
  meta_ad_id: string;
  reach: string;
  frequency: string;
  sync_run_id: string;
}

interface ActionRow {
  meta_ad_id: string;
  action_type: string;
  count: string;
  value: string | null;
  sync_run_id: string;
}

interface NetNewRow {
  meta_ad_id: string;
  status: string;
  reason: string | null;
  net_new_reach: string | null;
}

interface AccountWindowRow {
  reach: string;
  frequency: string;
}

function denominatorValue(
  field: DenominatorField | null,
  row: {
    impressions: number;
    clicks: number;
    linkClicks: number;
    landingPageViews: number;
  },
): number | null {
  if (field === null) return null;
  switch (field) {
    case "impressions":
      return row.impressions;
    case "clicks":
      return row.clicks;
    case "link_clicks":
      return row.linkClicks;
    case "landing_page_views":
      return row.landingPageViews;
  }
}

/**
 * Leitmetrik at windowEnd, but only rows that existed at dataAsOf.
 * Backdated assignments created later must not rewrite past evaluations.
 */
async function loadMetricDefinition(
  pool: Queryable,
  tenantId: string,
  adAccountId: string,
  windowEnd: Date,
  dataAsOf: DataAsOf,
): Promise<MetricDefinitionInfo> {
  const asOf = dataAsOfCutoff(dataAsOf);
  const assigned = await pool.query<StoredMetricRow & { assignment_id: string }>(
    `SELECT
       m.id,
       m.version,
       m.label,
       m.numerator_action_types,
       m.numerator_aggregation,
       m.attribution_spec,
       m.denominator,
       m.value_source,
       m.fixed_value::text,
       m.currency,
       a.id AS assignment_id
     FROM ad_account_metric_assignment a
     JOIN conversion_metric m
       ON m.id = a.conversion_metric_id
      AND m.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1
       AND a.meta_ad_account_id = $2
       AND a.created_at <= $4::timestamptz
       AND a.effective_from <= $3
       AND m.created_at <= $4::timestamptz
       AND m.effective_from <= $3
       AND NOT EXISTS (
         SELECT 1
         FROM conversion_metric newer
         WHERE newer.tenant_id = m.tenant_id
           AND newer.id = m.id
           AND newer.version > m.version
           AND newer.created_at <= $4::timestamptz
           AND newer.effective_from <= $3
       )
       AND NOT EXISTS (
         SELECT 1
         FROM ad_account_metric_assignment newer_a
         WHERE newer_a.tenant_id = a.tenant_id
           AND newer_a.meta_ad_account_id = a.meta_ad_account_id
           AND newer_a.created_at <= $4::timestamptz
           AND newer_a.effective_from <= $3
           AND (
             newer_a.effective_from > a.effective_from
             OR (
               newer_a.effective_from = a.effective_from
               AND newer_a.created_at > a.created_at
             )
           )
       )
     ORDER BY a.effective_from DESC, a.created_at DESC, m.version DESC
     LIMIT 1`,
    [tenantId, adAccountId, windowEnd.toISOString(), asOf],
  );
  if (assigned.rows[0]) {
    return toMetricDefinitionInfo(assigned.rows[0], "user");
  }
  return FALLBACK_PURCHASE_METRIC;
}

export async function resolveMetrics(
  params: ResolveMetricsParams,
): Promise<ResolveMetricsResult> {
  const { pool, tenantId, adAccountId, windowStart, windowEnd, dataAsOf } =
    params;
  const asOf = dataAsOfCutoff(dataAsOf);

  const account = await pool.query<{ currency: string }>(
    `SELECT currency FROM meta_ad_account WHERE id = $1 AND tenant_id = $2`,
    [adAccountId, tenantId],
  );
  const accountCurrency = account.rows[0]?.currency;
  if (!accountCurrency) {
    throw new Error("meta_ad_account_not_found");
  }

  const metricDefinition = await loadMetricDefinition(
    pool,
    tenantId,
    adAccountId,
    // Leitmetrik is resolved at windowEnd, not "today".
    new Date(`${windowEnd}T23:59:59.999Z`),
    dataAsOf,
  );

  const emptyRoas = {
    spend: 0,
    metaValue: null as number | null,
    numeratorCount: null as number | null,
    valueSource: metricDefinition.valueSource,
    fixedValue: metricDefinition.fixedValue,
    fixedCurrency: metricDefinition.currency,
    accountCurrency,
    attributionSpec: metricDefinition.attributionSpec,
    dataAsOf: typeof dataAsOf === "string" ? new Date(dataAsOf) : dataAsOf,
  };

  const gateReasons: GateReason[] = [];
  if (!attributionIsSynced(metricDefinition.attributionSpec)) {
    gateReasons.push("attribution_not_synced");
    return {
      rows: [],
      accountTotals: {
        spend: 0,
        impressions: 0,
        clicks: 0,
        linkClicks: 0,
        landingPageViews: 0,
        reach: null,
        frequency: null,
        numerator: null,
        numeratorReason: null,
        denominator: null,
        cvr: null,
        cpa: null,
        metaRoas: computeMetaRoas(emptyRoas),
        expectedValueRoas: computeExpectedValueRoas(emptyRoas),
        realizedValueRoas: realizedValueRoasPlaceholder(emptyRoas),
      },
      metricDefinition,
      accountCurrency,
      gateStatus: "insufficient_data",
      gateReasons,
      missingDateRange: null,
    };
  }

  const daily = await pool.query<DailyAggRow>(
    `SELECT
       d.meta_ad_id,
       SUM(d.spend)::text AS spend,
       SUM(d.impressions)::text AS impressions,
       SUM(d.clicks)::text AS clicks,
       SUM(d.link_clicks)::text AS link_clicks,
       SUM(d.landing_page_views)::text AS landing_page_views,
       ARRAY_AGG(DISTINCT d.sync_run_id::text) AS sync_run_ids
     FROM insight_daily_as_of($1, $2::timestamptz) d
     WHERE d.date BETWEEN $3::date AND $4::date
       AND EXISTS (
         SELECT 1
         FROM insight_sync_run r
         WHERE r.id = d.sync_run_id
           AND r.tenant_id = $1
           AND r.meta_ad_account_id = $5
       )
     GROUP BY d.meta_ad_id
     ORDER BY d.meta_ad_id`,
    [tenantId, asOf, windowStart, windowEnd, adAccountId],
  );

  const dailyDates = await pool.query<DailyDateRow>(
    `SELECT d.meta_ad_id, d.date::text AS date
     FROM insight_daily_as_of($1, $2::timestamptz) d
     WHERE d.date BETWEEN $3::date AND $4::date
       AND EXISTS (
         SELECT 1
         FROM insight_sync_run r
         WHERE r.id = d.sync_run_id
           AND r.tenant_id = $1
           AND r.meta_ad_account_id = $5
       )`,
    [tenantId, asOf, windowStart, windowEnd, adAccountId],
  );
  const datesByAd = new Map<string, Set<string>>();
  for (const row of dailyDates.rows) {
    const set = datesByAd.get(row.meta_ad_id) ?? new Set<string>();
    set.add(row.date);
    datesByAd.set(row.meta_ad_id, set);
  }
  const expectedDates = eachDateInclusive(windowStart, windowEnd);

  const windows = await pool.query<WindowRow>(
    `SELECT w.meta_ad_id, w.reach::text, w.frequency::text, w.sync_run_id::text
     FROM insight_window_as_of($1, $2::timestamptz) w
     JOIN insight_sync_run r
       ON r.id = w.sync_run_id
      AND r.tenant_id = $1
     WHERE r.meta_ad_account_id = $3
       AND w.window_start = $4::date
       AND w.window_end = $5::date
       AND w.is_cumulative = false`,
    [tenantId, asOf, adAccountId, windowStart, windowEnd],
  );
  const windowByAd = new Map(windows.rows.map((row) => [row.meta_ad_id, row]));

  const accountWindow = await pool.query<AccountWindowRow>(
    `SELECT w.reach::text, w.frequency::text
     FROM insight_account_window_as_of($1, $2::timestamptz) w
     WHERE w.meta_ad_account_id = $3
       AND w.window_start = $4::date
       AND w.window_end = $5::date
     LIMIT 1`,
    [tenantId, asOf, adAccountId, windowStart, windowEnd],
  );

  const actions = await pool.query<ActionRow>(
    `SELECT
       a.meta_ad_id,
       a.action_type,
       SUM(a.count)::text AS count,
       CASE
         WHEN COUNT(*) FILTER (WHERE a.value IS NULL) > 0
           AND COUNT(*) FILTER (WHERE a.value IS NOT NULL) = 0
           THEN NULL
         WHEN COUNT(*) FILTER (WHERE a.value IS NULL) > 0
           THEN NULL
         ELSE SUM(a.value)::text
       END AS value,
       (ARRAY_AGG(a.sync_run_id::text ORDER BY a.date))[1] AS sync_run_id
     FROM insight_action_daily_as_of($1, $2::timestamptz) a
     JOIN insight_sync_run r
       ON r.id = a.sync_run_id
      AND r.tenant_id = $1
     WHERE r.meta_ad_account_id = $3
       AND a.date BETWEEN $4::date AND $5::date
       AND a.attribution_spec = $6::text[]
       AND a.action_type = ANY($7::text[])
     GROUP BY a.meta_ad_id, a.action_type`,
    [
      tenantId,
      asOf,
      adAccountId,
      windowStart,
      windowEnd,
      [...metricDefinition.attributionSpec].sort(),
      metricDefinition.numeratorActionTypes,
    ],
  );

  const actionsByAd = new Map<string, ActionObservation[]>();
  for (const row of actions.rows) {
    const list = actionsByAd.get(row.meta_ad_id) ?? [];
    list.push({
      actionType: row.action_type,
      present: true,
      count: Number(row.count),
      value: row.value === null ? null : Number(row.value),
    });
    actionsByAd.set(row.meta_ad_id, list);
  }

  const netNew = await pool.query<NetNewRow>(
    `SELECT
       d.meta_ad_id,
       n.status,
       n.reason,
       n.net_new_reach::text
     FROM (SELECT DISTINCT meta_ad_id FROM insight_daily_as_of($1, $2::timestamptz)
           WHERE date BETWEEN $3::date AND $4::date) d
     CROSS JOIN LATERAL net_new_reach_as_of(
       $1, d.meta_ad_id, $3::date, $4::date, $2::timestamptz
     ) n`,
    [tenantId, asOf, windowStart, windowEnd],
  );
  const netNewByAd = new Map(netNew.rows.map((row) => [row.meta_ad_id, row]));

  const rows: PerAdBaseMetrics[] = [];
  let accountMissingRange: MissingDateRange | null = null;

  for (const day of daily.rows) {
    const present = datesByAd.get(day.meta_ad_id) ?? new Set<string>();
    const missingDateRange = firstMissingDateRange(expectedDates, present);
    const windowComplete = missingDateRange === null;
    if (!windowComplete && accountMissingRange === null) {
      accountMissingRange = missingDateRange;
    }

    const spend = Number(day.spend);
    const impressions = Number(day.impressions);
    const clicks = Number(day.clicks);
    const linkClicks = Number(day.link_clicks);
    const landingPageViews = Number(day.landing_page_views);
    const windowRow = windowByAd.get(day.meta_ad_id);
    const reach = windowRow ? Number(windowRow.reach) : null;
    const frequency = windowRow ? Number(windowRow.frequency) : null;
    const net = netNewByAd.get(day.meta_ad_id);
    const netNewReach =
      net?.status === "available" && net.net_new_reach !== null
        ? Number(net.net_new_reach)
        : null;
    const netNewReachReason =
      net?.reason === "cumulative_reach_missing"
        ? ("cumulative_reach_missing" as const)
        : null;

    const aggregated = aggregateNumerator(
      actionsByAd.get(day.meta_ad_id) ?? [],
      metricDefinition.numeratorActionTypes,
      metricDefinition.numeratorAggregation,
    );
    const denominator = denominatorValue(metricDefinition.denominator, {
      impressions,
      clicks,
      linkClicks,
      landingPageViews,
    });
    // Incomplete windows must not look like full-window rates.
    const usable = windowComplete;
    const cvr =
      !usable || denominator === null
        ? null
        : aggregated.count === null
          ? null
          : denominator > 0
            ? aggregated.count / denominator
            : null;
    const cpa =
      usable &&
      aggregated.count !== null &&
      aggregated.count > 0 &&
      spend > 0
        ? spend / aggregated.count
        : null;

    let resolvedValue: number | null = null;
    if (usable && metricDefinition.valueSource === "meta_value") {
      resolvedValue = aggregated.value;
    } else if (
      usable &&
      metricDefinition.valueSource === "fixed" &&
      metricDefinition.fixedValue !== null &&
      aggregated.count !== null
    ) {
      resolvedValue = metricDefinition.fixedValue * aggregated.count;
    }

    const valuePerImpression =
      !usable || resolvedValue === null || impressions <= 0
        ? null
        : resolvedValue / impressions;

    const roasInput = {
      spend: usable ? spend : 0,
      metaValue: usable ? aggregated.value : null,
      numeratorCount: usable ? aggregated.count : null,
      valueSource: metricDefinition.valueSource,
      fixedValue: metricDefinition.fixedValue,
      fixedCurrency: metricDefinition.currency,
      accountCurrency,
      attributionSpec: metricDefinition.attributionSpec,
      dataAsOf: typeof dataAsOf === "string" ? new Date(dataAsOf) : dataAsOf,
    };

    const syncRunIds = [
      ...new Set([
        ...day.sync_run_ids,
        ...(windowRow ? [windowRow.sync_run_id] : []),
      ]),
    ];

    rows.push({
      metaAdId: day.meta_ad_id,
      spend,
      impressions,
      clicks,
      linkClicks,
      landingPageViews,
      reach,
      frequency,
      windowSynced: Boolean(windowRow),
      netNewReach,
      netNewReachReason,
      numerator: usable ? aggregated.count : null,
      metaValue: usable ? aggregated.value : null,
      denominator: usable ? denominator : null,
      cvr,
      cpa,
      valuePerImpression,
      metaRoas: computeMetaRoas(roasInput),
      expectedValueRoas: computeExpectedValueRoas(roasInput),
      realizedValueRoas: realizedValueRoasPlaceholder(roasInput),
      syncRunIds,
      windowComplete,
      missingDateRange,
    });
  }

  if (accountMissingRange !== null) {
    gateReasons.push("window_incomplete");
  }

  const completeRows = rows.filter((row) => row.windowComplete);
  const accountSpend = completeRows.reduce((sum, row) => sum + row.spend, 0);
  const accountImpressions = completeRows.reduce(
    (sum, row) => sum + row.impressions,
    0,
  );
  const accountClicks = completeRows.reduce((sum, row) => sum + row.clicks, 0);
  const accountLinkClicks = completeRows.reduce(
    (sum, row) => sum + row.linkClicks,
    0,
  );
  const accountLpv = completeRows.reduce(
    (sum, row) => sum + row.landingPageViews,
    0,
  );

  // Finding 9: a missing observation makes the account total unknown, not zero.
  let accountNumerator: number | null = null;
  let numeratorReason: GateReason | null = null;
  if (completeRows.length === 0) {
    accountNumerator = null;
  } else if (completeRows.some((row) => row.numerator === null)) {
    accountNumerator = null;
    numeratorReason = "missing_observations";
    gateReasons.push("missing_observations");
  } else {
    accountNumerator = completeRows.reduce(
      (sum, row) => sum + (row.numerator as number),
      0,
    );
  }

  const accountDenominator =
    metricDefinition.denominator === null || completeRows.length === 0
      ? null
      : denominatorValue(metricDefinition.denominator, {
          impressions: accountImpressions,
          clicks: accountClicks,
          linkClicks: accountLinkClicks,
          landingPageViews: accountLpv,
        });
  const accountMetaValue =
    completeRows.length === 0
      ? null
      : completeRows.some((row) => row.metaValue === null)
        ? null
        : completeRows.reduce((sum, row) => sum + (row.metaValue as number), 0);

  const accountReach =
    accountWindow.rows[0] !== undefined
      ? Number(accountWindow.rows[0].reach)
      : null;
  const accountFrequency =
    accountWindow.rows[0] !== undefined
      ? Number(accountWindow.rows[0].frequency)
      : null;

  const accountRoasInput = {
    spend: accountSpend,
    metaValue: accountMetaValue,
    numeratorCount: accountNumerator,
    valueSource: metricDefinition.valueSource,
    fixedValue: metricDefinition.fixedValue,
    fixedCurrency: metricDefinition.currency,
    accountCurrency,
    attributionSpec: metricDefinition.attributionSpec,
    dataAsOf: typeof dataAsOf === "string" ? new Date(dataAsOf) : dataAsOf,
  };

  const gateStatus: GateStatus =
    gateReasons.length > 0 ? "insufficient_data" : "ok";

  return {
    rows,
    accountTotals: {
      spend: accountSpend,
      impressions: accountImpressions,
      clicks: accountClicks,
      linkClicks: accountLinkClicks,
      landingPageViews: accountLpv,
      reach: accountReach,
      frequency: accountFrequency,
      numerator: accountNumerator,
      numeratorReason,
      denominator: accountDenominator,
      cvr:
        accountDenominator === null ||
        accountNumerator === null ||
        accountDenominator <= 0
          ? null
          : accountNumerator / accountDenominator,
      cpa:
        accountNumerator !== null && accountNumerator > 0 && accountSpend > 0
          ? accountSpend / accountNumerator
          : null,
      metaRoas: computeMetaRoas(accountRoasInput),
      expectedValueRoas: computeExpectedValueRoas(accountRoasInput),
      realizedValueRoas: realizedValueRoasPlaceholder(accountRoasInput),
    },
    metricDefinition,
    accountCurrency,
    gateStatus,
    gateReasons: [...new Set(gateReasons)],
    missingDateRange: accountMissingRange,
  };
}
