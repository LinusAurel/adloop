import type { Queryable } from "@/db/queryable";
import { computeCreativeStrain } from "./creative-strain";
import { dataGateV1 } from "./score-config/data-gate-v1";
import { pulseV1 } from "./score-config/pulse-v1";
import { median } from "./stats";
import type { ResolveMetricsResult } from "./resolve";
import type {
  PulseBandCode,
  PulseIndexReason,
} from "./types";

export type PulseIndex =
  | {
      status: "ok";
      value: number;
      band: Exclude<PulseBandCode, "insufficient_data">;
    }
  | {
      status: "insufficient_data";
      value: null;
      band: "insufficient_data";
      reason: PulseIndexReason;
    };

export interface PulseResult {
  version: typeof pulseV1.version;
  creativeStrain: PulseIndex;
  spendEfficiency: PulseIndex;
  accountHealth: PulseIndex;
  overall: PulseIndex;
}

function bandFor(value: number): Exclude<PulseBandCode, "insufficient_data"> {
  if (value >= pulseV1.bands.good) return "healthy";
  if (value >= pulseV1.bands.warn) return "attention_required";
  return "critical";
}

function okIndex(value: number): PulseIndex {
  const clamped = Math.max(0, Math.min(100, value));
  return { status: "ok", value: clamped, band: bandFor(clamped) };
}

function insufficient(reason: PulseIndexReason): PulseIndex {
  return {
    status: "insufficient_data",
    value: null,
    band: "insufficient_data",
    reason,
  };
}

/** Ads that pass the data-gate spend/impressions floor and have a complete window. */
export function adsInGate(resolved: ResolveMetricsResult): ResolveMetricsResult["rows"] {
  return resolved.rows.filter(
    (row) =>
      row.windowComplete &&
      row.spend >= dataGateV1.minSpend &&
      row.impressions >= dataGateV1.minImpressions,
  );
}

/**
 * Spend Efficiency — share of gate spend flowing to ads at or below median CPA.
 * Without a cost-bearing numerator the index is unavailable.
 */
export function computeSpendEfficiency(resolved: ResolveMetricsResult): PulseIndex {
  if (resolved.metricDefinition.numeratorActionTypes.length === 0) {
    return insufficient("no_conversion_metric");
  }
  // Leitmetrik with no cost link (value_source none and no conversions usable as CPA)
  // still uses CPA = spend/numerator when numerator is present.
  const gated = adsInGate(resolved).filter(
    (row) => row.cpa !== null && Number.isFinite(row.cpa) && row.cpa > 0,
  );
  if (gated.length === 0) {
    return insufficient("no_ads_in_gate");
  }
  const cpas = gated.map((row) => row.cpa as number);
  const medianCpa = median(cpas);
  if (medianCpa === null) return insufficient("no_ads_in_gate");

  const totalSpend = gated.reduce((sum, row) => sum + row.spend, 0);
  if (totalSpend <= 0) return insufficient("no_spend");

  const efficientSpend = gated
    .filter((row) => (row.cpa as number) <= medianCpa)
    .reduce((sum, row) => sum + row.spend, 0);

  return okIndex(100 * (efficientSpend / totalSpend));
}

export interface AccountHealthSignals {
  tokenExpired: boolean;
  lastSyncFailed: boolean;
  /** Reserved for Etappe 7 metric_optimization_binding — unused until then. */
  metricBindingMissing: boolean;
  noConversionMetric: boolean;
}

export function computeAccountHealth(
  resolved: ResolveMetricsResult,
  signals: AccountHealthSignals,
): PulseIndex {
  const spending = resolved.rows.filter((row) => row.spend > 0);
  if (spending.length === 0) {
    return insufficient("no_ads_in_gate");
  }
  const gated = adsInGate(resolved);
  const basis = 100 * (gated.length / spending.length);

  let penalties = 0;
  if (signals.tokenExpired) penalties += pulseV1.healthPenaltyPerError;
  if (signals.lastSyncFailed) penalties += pulseV1.healthPenaltyPerError;
  if (signals.metricBindingMissing) penalties += pulseV1.healthPenaltyPerError;
  if (signals.noConversionMetric) penalties += pulseV1.healthPenaltyPerError;

  return okIndex(Math.max(0, basis - penalties));
}

export async function computeCreativeStrainIndex(params: {
  pool: Queryable;
  tenantId: string;
  adAccountId: string;
  windowStart: string;
  windowEnd: string;
  dataAsOf: string;
  metaAdIds: string[];
}): Promise<PulseIndex> {
  if (params.metaAdIds.length === 0) {
    return insufficient("no_ads_in_gate");
  }
  const strain = await computeCreativeStrain({
    pool: params.pool,
    tenantId: params.tenantId,
    adAccountId: params.adAccountId,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    dataAsOf: params.dataAsOf,
    metaAdIds: params.metaAdIds,
  });
  const scored = strain.ads.filter((ad) => ad.value !== null);
  if (scored.length === 0) {
    return insufficient("insufficient_data");
  }
  const mean =
    scored.reduce((sum, ad) => sum + (ad.value as number), 0) / scored.length;
  return okIndex(mean);
}

/**
 * Weighted mean of available indices, renormalized onto the present weights.
 * If none are available, overall is insufficient_data.
 */
export function computeOverallPulse(parts: {
  creativeStrain: PulseIndex;
  spendEfficiency: PulseIndex;
  accountHealth: PulseIndex;
}): PulseIndex {
  const weighted: Array<{ weight: number; value: number }> = [];
  if (parts.creativeStrain.status === "ok") {
    weighted.push({
      weight: pulseV1.weights.creativeStrain,
      value: parts.creativeStrain.value,
    });
  }
  if (parts.spendEfficiency.status === "ok") {
    weighted.push({
      weight: pulseV1.weights.spendEfficiency,
      value: parts.spendEfficiency.value,
    });
  }
  if (parts.accountHealth.status === "ok") {
    weighted.push({
      weight: pulseV1.weights.accountHealth,
      value: parts.accountHealth.value,
    });
  }
  if (weighted.length === 0) {
    return insufficient("insufficient_data");
  }
  const weightSum = weighted.reduce((sum, part) => sum + part.weight, 0);
  const value =
    weighted.reduce((sum, part) => sum + part.weight * part.value, 0) / weightSum;
  return okIndex(value);
}

export async function computePulse(params: {
  pool: Queryable;
  tenantId: string;
  adAccountId: string;
  windowStart: string;
  windowEnd: string;
  dataAsOf: string;
  resolved: ResolveMetricsResult;
  signals: AccountHealthSignals;
}): Promise<PulseResult> {
  const creativeStrain = await computeCreativeStrainIndex({
    pool: params.pool,
    tenantId: params.tenantId,
    adAccountId: params.adAccountId,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    dataAsOf: params.dataAsOf,
    metaAdIds: params.resolved.rows.map((row) => row.metaAdId),
  });
  const spendEfficiency = computeSpendEfficiency(params.resolved);
  const accountHealth = computeAccountHealth(params.resolved, params.signals);
  const overall = computeOverallPulse({
    creativeStrain,
    spendEfficiency,
    accountHealth,
  });
  return {
    version: pulseV1.version,
    creativeStrain,
    spendEfficiency,
    accountHealth,
    overall,
  };
}
