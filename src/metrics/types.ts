export const FUNNEL_POSITION_FORMULA_VERSION = "funnel_position_v1" as const;
export const CREATIVE_STRAIN_FORMULA_VERSION = "creative_strain_v1" as const;

/** Family prefixes — historical reads match any version in the family. */
export const FUNNEL_POSITION_FORMULA_PREFIX = "funnel_position_" as const;
export const CREATIVE_STRAIN_FORMULA_PREFIX = "creative_strain_" as const;

/** Attribution set that Etappe 2 actually syncs and stores. */
export const SYNCED_ATTRIBUTION_SPEC = ["1d_view", "7d_click"] as const;

export type GateReason =
  | "below_minimum_spend"
  | "below_minimum_impressions"
  | "zero_reach"
  | "zero_denominator"
  | "population_too_small"
  | "no_variance"
  | "window_not_synced"
  | "cumulative_reach_missing"
  | "attribution_not_synced"
  | "window_too_short"
  | "no_spend"
  | "currency_mismatch"
  | "window_incomplete"
  | "no_snapshot"
  | "missing_observations"
  | "previous_period_incomplete"
  | "no_ads_in_gate"
  | "no_conversion_metric"
  | "snapshot_mismatch";

export type PulseBandCode =
  | "healthy"
  | "attention_required"
  | "critical"
  | "insufficient_data";

export type PulseIndexReason =
  | "no_ads_in_gate"
  | "no_conversion_metric"
  | "previous_period_incomplete"
  | "window_incomplete"
  | "no_spend"
  | "insufficient_data";

export type GateStatus = "ok" | "insufficient_data";

export type FunnelBand = "prospector" | "mixed" | "closer";

export type NumeratorAggregation =
  | "sum_disjoint"
  | "coalesce_aliases"
  | "first_present";

export type DenominatorField =
  | "impressions"
  | "clicks"
  | "link_clicks"
  | "landing_page_views";

export type ValueSource = "meta_value" | "fixed" | "none";

export type ConfiguredBy = "user" | "default" | "fallback";
