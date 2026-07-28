import type { Pool } from "pg";
import { computeFunnelPosition } from "@/metrics/funnel-position";
import {
  compareNumber,
  previousPeriodCoverage,
  previousWindowBounds,
  type ComparedNumber,
} from "@/metrics/previous-period";
import { computePulse, type PulseResult } from "@/metrics/pulse";
import { resolveMetrics, type ResolveMetricsResult } from "@/metrics/resolve";
import {
  computeAndPersistSnapshots,
  dataAsOfIsLatestSync,
  latestSyncDataAsOf,
  readScoreSnapshots,
} from "@/metrics/snapshots";
import {
  CREATIVE_STRAIN_FORMULA_PREFIX,
  CREATIVE_STRAIN_FORMULA_VERSION,
  FUNNEL_POSITION_FORMULA_PREFIX,
  type FunnelBand,
  type GateReason,
  type GateStatus,
} from "@/metrics/types";
import { adTableArtifact, type AdTableArtifact } from "./artifacts";

export interface StrategistOverview {
  metaAdAccountId: string;
  windowStart: string;
  windowEnd: string;
  previousWindowStart: string;
  previousWindowEnd: string;
  dataAsOf: string;
  metricDefinition: {
    id: string;
    version: number;
    label: string;
    configuredBy: string;
  };
  accountCurrency: string;
  pulse: PulseResult;
  overview: {
    spend: ComparedNumber;
    impressions: ComparedNumber;
    clicks: ComparedNumber;
    reach: ComparedNumber;
    frequency: ComparedNumber;
    conversions: ComparedNumber;
    cpa: ComparedNumber;
    cpm: ComparedNumber;
    ctr: ComparedNumber;
    roas: ComparedNumber;
  };
  previousPeriodComplete: boolean;
  ads: StrategistAdRow[];
  adTableArtifact: AdTableArtifact;
}

export interface StrategistAdRow {
  metaAdId: string;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  spend: ComparedNumber;
  impressions: ComparedNumber;
  conversions: ComparedNumber;
  conversionValue: ComparedNumber;
  cpa: ComparedNumber;
  cpm: ComparedNumber;
  ctr: ComparedNumber;
  reach: ComparedNumber;
  netNewReach: ComparedNumber;
  funnelPosition: {
    gateStatus: GateStatus;
    gateReasons: GateReason[];
    score: number | null;
    band: FunnelBand | null;
    snapshotId: string | null;
  };
  creativeStrain: {
    gateStatus: GateStatus;
    gateReasons: GateReason[];
    value: number | null;
  };
}

async function loadAccountHealthSignals(
  pool: Pool,
  tenantId: string,
  adAccountId: string,
  configuredBy: string,
): Promise<{
  tokenExpired: boolean;
  lastSyncFailed: boolean;
  metricBindingMissing: boolean;
  noConversionMetric: boolean;
}> {
  const account = await pool.query<{
    connection_status: string;
    last_sync_status: string | null;
  }>(
    `SELECT c.status AS connection_status,
            (
              SELECT s.status
              FROM insight_sync_run s
              WHERE s.tenant_id = a.tenant_id
                AND s.meta_ad_account_id = a.id
              ORDER BY s.started_at DESC
              LIMIT 1
            ) AS last_sync_status
     FROM meta_ad_account a
     JOIN meta_connection c ON c.id = a.connection_id AND c.tenant_id = a.tenant_id
     WHERE a.id = $1 AND a.tenant_id = $2`,
    [adAccountId, tenantId],
  );
  const row = account.rows[0];
  return {
    tokenExpired: row?.connection_status === "expired",
    lastSyncFailed: row?.last_sync_status === "failed",
    // metric_optimization_binding arrives in Etappe 7 — never active here.
    metricBindingMissing: false,
    noConversionMetric: configuredBy === "fallback",
  };
}

async function loadAdNames(
  pool: Pool,
  tenantId: string,
  dataAsOf: string,
  metaAdIds: string[],
): Promise<Map<string, { name: string; status: string; effectiveStatus: string }>> {
  if (metaAdIds.length === 0) return new Map();
  const result = await pool.query<{
    meta_ad_id: string;
    name: string;
    status: string;
    effective_status: string;
  }>(
    `SELECT meta_ad_id, name, status, effective_status
     FROM meta_ad_as_of($1::uuid, $2::timestamptz)
     WHERE meta_ad_id = ANY($3::text[])`,
    [tenantId, dataAsOf, metaAdIds],
  );
  return new Map(
    result.rows.map((row) => [
      row.meta_ad_id,
      {
        name: row.name,
        status: row.status,
        effectiveStatus: row.effective_status,
      },
    ]),
  );
}

function rateMetrics(resolved: ResolveMetricsResult): {
  ctr: number | null;
  cpm: number | null;
} {
  const { impressions, clicks, spend } = resolved.accountTotals;
  return {
    ctr: impressions > 0 ? clicks / impressions : null,
    cpm: impressions > 0 && spend > 0 ? (spend / impressions) * 1000 : null,
  };
}

function adRateMetrics(row: ResolveMetricsResult["rows"][number]): {
  ctr: number | null;
  cpm: number | null;
  conversionValue: number | null;
} {
  return {
    ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
    cpm:
      row.impressions > 0 && row.spend > 0
        ? (row.spend / row.impressions) * 1000
        : null,
    conversionValue:
      row.metaRoas.value !== null && row.spend > 0
        ? row.metaRoas.value * row.spend
        : row.metaValue,
  };
}

export async function buildStrategistOverview(params: {
  pool: Pool;
  tenantId: string;
  metaAdAccountId: string;
  windowStart: string;
  windowEnd: string;
  dataAsOf?: string;
}): Promise<StrategistOverview> {
  const latest = await latestSyncDataAsOf(
    params.pool,
    params.tenantId,
    params.metaAdAccountId,
  );
  const dataAsOf = params.dataAsOf ?? latest ?? new Date().toISOString();
  const live = await dataAsOfIsLatestSync(params.pool, dataAsOf, latest);

  const previousBounds = previousWindowBounds(params.windowStart, params.windowEnd);

  const current = await resolveMetrics({
    pool: params.pool,
    tenantId: params.tenantId,
    adAccountId: params.metaAdAccountId,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    dataAsOf,
  });

  const previous = await resolveMetrics({
    pool: params.pool,
    tenantId: params.tenantId,
    adAccountId: params.metaAdAccountId,
    windowStart: previousBounds.start,
    windowEnd: previousBounds.end,
    dataAsOf,
  });

  const coverage = previousPeriodCoverage(current, previous);
  const prevReason = coverage.complete ? undefined : ("previous_period_incomplete" as const);

  const signals = await loadAccountHealthSignals(
    params.pool,
    params.tenantId,
    params.metaAdAccountId,
    current.metricDefinition.configuredBy,
  );

  const pulse = await computePulse({
    pool: params.pool,
    tenantId: params.tenantId,
    adAccountId: params.metaAdAccountId,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    dataAsOf,
    resolved: current,
    signals,
  });

  let funnelByAd = new Map<
    string,
    {
      gateStatus: GateStatus;
      gateReasons: GateReason[];
      score: number | null;
      band: FunnelBand | null;
      snapshotId: string | null;
    }
  >();
  let strainByAd = new Map<
    string,
    { gateStatus: GateStatus; gateReasons: GateReason[]; value: number | null }
  >();

  if (live) {
    const persisted = await computeAndPersistSnapshots({
      pool: params.pool,
      tenantId: params.tenantId,
      adAccountId: params.metaAdAccountId,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      dataAsOf,
      sourceSyncRunIds: [],
    });
    const funnel = computeFunnelPosition({
      rows: current.rows,
      metricDefinition: current.metricDefinition,
      accountCurrency: current.accountCurrency,
    });
    funnel.ads.forEach((ad, index) => {
      funnelByAd.set(ad.metaAdId, {
        gateStatus: ad.gateStatus,
        gateReasons: ad.gateReasons,
        score: ad.score,
        band: ad.band,
        snapshotId: persisted.funnelSnapshotIds[index] ?? null,
      });
    });
    const strainSnapshots = await readScoreSnapshots({
      pool: params.pool,
      tenantId: params.tenantId,
      adAccountId: params.metaAdAccountId,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      dataAsOf,
      formulaVersion: CREATIVE_STRAIN_FORMULA_VERSION,
    });
    for (const [subjectId, row] of strainSnapshots) {
      strainByAd.set(subjectId, {
        gateStatus: row.gateStatus,
        gateReasons: row.gateReasons,
        value: row.value,
      });
    }
  } else {
    const funnelSnapshots = await readScoreSnapshots({
      pool: params.pool,
      tenantId: params.tenantId,
      adAccountId: params.metaAdAccountId,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      dataAsOf,
      formulaPrefix: FUNNEL_POSITION_FORMULA_PREFIX,
    });
    const strainSnapshots = await readScoreSnapshots({
      pool: params.pool,
      tenantId: params.tenantId,
      adAccountId: params.metaAdAccountId,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      dataAsOf,
      formulaPrefix: CREATIVE_STRAIN_FORMULA_PREFIX,
    });
    // Need snapshot ids — readScoreSnapshots doesn't return id. Query directly.
    const funnelIds = await params.pool.query<{ id: string; subject_id: string }>(
      `SELECT DISTINCT ON (subject_id) id, subject_id
       FROM metric_snapshot
       WHERE tenant_id = $1
         AND meta_ad_account_id = $2
         AND subject_type = 'ad'
         AND formula_version LIKE ($3 || '%')
         AND window_start = $4::date
         AND window_end = $5::date
         AND data_as_of <= $6::timestamptz
       ORDER BY subject_id, data_as_of DESC, computed_at DESC`,
      [
        params.tenantId,
        params.metaAdAccountId,
        FUNNEL_POSITION_FORMULA_PREFIX,
        params.windowStart,
        params.windowEnd,
        dataAsOf,
      ],
    );
    const idBySubject = new Map(funnelIds.rows.map((row) => [row.subject_id, row.id]));
    for (const [subjectId, row] of funnelSnapshots) {
      const inputs = row.inputs as { band?: FunnelBand | null } | null;
      funnelByAd.set(subjectId, {
        gateStatus: row.gateStatus,
        gateReasons: row.gateReasons,
        score: row.value,
        band: inputs?.band ?? null,
        snapshotId: idBySubject.get(subjectId) ?? null,
      });
    }
    for (const [subjectId, row] of strainSnapshots) {
      strainByAd.set(subjectId, {
        gateStatus: row.gateStatus,
        gateReasons: row.gateReasons,
        value: row.value,
      });
    }
  }

  const names = await loadAdNames(
    params.pool,
    params.tenantId,
    dataAsOf,
    current.rows.map((row) => row.metaAdId),
  );

  const previousByAd = new Map(previous.rows.map((row) => [row.metaAdId, row]));
  const currentRates = rateMetrics(current);
  const previousRates = rateMetrics(previous);

  const overview = {
    spend: compareNumber(
      current.accountTotals.spend,
      coverage.complete ? previous.accountTotals.spend : null,
      prevReason,
    ),
    impressions: compareNumber(
      current.accountTotals.impressions,
      coverage.complete ? previous.accountTotals.impressions : null,
      prevReason,
    ),
    clicks: compareNumber(
      current.accountTotals.clicks,
      coverage.complete ? previous.accountTotals.clicks : null,
      prevReason,
    ),
    reach: compareNumber(
      current.accountTotals.reach,
      coverage.complete ? previous.accountTotals.reach : null,
      prevReason,
    ),
    frequency: compareNumber(
      current.accountTotals.frequency,
      coverage.complete ? previous.accountTotals.frequency : null,
      prevReason,
    ),
    conversions: compareNumber(
      current.accountTotals.numerator,
      coverage.complete ? previous.accountTotals.numerator : null,
      prevReason,
    ),
    cpa: compareNumber(
      current.accountTotals.cpa,
      coverage.complete ? previous.accountTotals.cpa : null,
      prevReason,
    ),
    cpm: compareNumber(
      currentRates.cpm,
      coverage.complete ? previousRates.cpm : null,
      prevReason,
    ),
    ctr: compareNumber(
      currentRates.ctr,
      coverage.complete ? previousRates.ctr : null,
      prevReason,
    ),
    roas: compareNumber(
      current.accountTotals.metaRoas.value,
      coverage.complete ? previous.accountTotals.metaRoas.value : null,
      prevReason,
    ),
  };

  const ads: StrategistAdRow[] = [...current.rows]
    .sort((a, b) => b.spend - a.spend)
    .map((row) => {
      const prior = previousByAd.get(row.metaAdId);
      const rates = adRateMetrics(row);
      const priorRates = prior ? adRateMetrics(prior) : null;
      const funnel = funnelByAd.get(row.metaAdId) ?? {
        gateStatus: "insufficient_data" as const,
        gateReasons: ["no_snapshot" as const],
        score: null,
        band: null,
        snapshotId: null,
      };
      const strain = strainByAd.get(row.metaAdId) ?? {
        gateStatus: "insufficient_data" as const,
        gateReasons: ["no_snapshot" as const],
        value: null,
      };
      const master = names.get(row.metaAdId);
      return {
        metaAdId: row.metaAdId,
        name: master?.name ?? null,
        status: master?.status ?? null,
        effectiveStatus: master?.effectiveStatus ?? null,
        spend: compareNumber(
          row.spend,
          coverage.complete ? (prior?.spend ?? null) : null,
          prevReason,
        ),
        impressions: compareNumber(
          row.impressions,
          coverage.complete ? (prior?.impressions ?? null) : null,
          prevReason,
        ),
        conversions: compareNumber(
          row.numerator,
          coverage.complete ? (prior?.numerator ?? null) : null,
          prevReason,
        ),
        conversionValue: compareNumber(
          rates.conversionValue,
          coverage.complete ? (priorRates?.conversionValue ?? null) : null,
          prevReason,
        ),
        cpa: compareNumber(
          row.cpa,
          coverage.complete ? (prior?.cpa ?? null) : null,
          prevReason,
        ),
        cpm: compareNumber(
          rates.cpm,
          coverage.complete ? (priorRates?.cpm ?? null) : null,
          prevReason,
        ),
        ctr: compareNumber(
          rates.ctr,
          coverage.complete ? (priorRates?.ctr ?? null) : null,
          prevReason,
        ),
        reach: compareNumber(
          row.reach,
          coverage.complete ? (prior?.reach ?? null) : null,
          prevReason,
        ),
        netNewReach: compareNumber(
          row.netNewReach,
          coverage.complete ? (prior?.netNewReach ?? null) : null,
          prevReason,
        ),
        funnelPosition: funnel,
        creativeStrain: strain,
      };
    });

  const artifact = adTableArtifact({
    rows: ads.map((ad) => ({
      id: ad.metaAdId,
      fields: [
        { fieldId: "name", labelCode: "strategist.col.ad", value: ad.name },
        {
          fieldId: "funnelPosition",
          labelCode: "strategist.col.funnel",
          value:
            ad.funnelPosition.gateStatus === "ok"
              ? ad.funnelPosition.band
              : ad.funnelPosition.gateReasons[0] ?? "insufficient_data",
        },
        {
          fieldId: "netNewReach",
          labelCode: "strategist.col.netNewReach",
          value: ad.netNewReach.value,
        },
        { fieldId: "spend", labelCode: "strategist.col.spend", value: ad.spend.value },
        {
          fieldId: "conversions",
          labelCode: "strategist.col.conversions",
          value: ad.conversions.value,
        },
        {
          fieldId: "conversionValue",
          labelCode: "strategist.col.conversionValue",
          value: ad.conversionValue.value,
        },
        { fieldId: "cpa", labelCode: "strategist.col.cpa", value: ad.cpa.value },
        { fieldId: "cpm", labelCode: "strategist.col.cpm", value: ad.cpm.value },
        { fieldId: "ctr", labelCode: "strategist.col.ctr", value: ad.ctr.value },
        {
          fieldId: "impressions",
          labelCode: "strategist.col.impressions",
          value: ad.impressions.value,
        },
      ],
    })),
  });

  return {
    metaAdAccountId: params.metaAdAccountId,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    previousWindowStart: previousBounds.start,
    previousWindowEnd: previousBounds.end,
    dataAsOf,
    metricDefinition: {
      id: current.metricDefinition.id,
      version: current.metricDefinition.version,
      label: current.metricDefinition.label,
      configuredBy: current.metricDefinition.configuredBy,
    },
    accountCurrency: current.accountCurrency,
    pulse,
    overview,
    previousPeriodComplete: coverage.complete,
    ads,
    adTableArtifact: artifact,
  };
}
