/**
 * Account-pulse index weights and bands.
 *
 * These weights are a reasoned assumption, not a measurement. They need real
 * account data before they can be treated as calibrated. Changing them
 * requires a new versioned config — never an in-place edit of this object.
 */
export const pulseV1 = {
  version: "pulse_v1",
  weights: {
    creativeStrain: 0.4,
    spendEfficiency: 0.35,
    accountHealth: 0.25,
  },
  /** Score >= good → healthy; score >= warn → attention_required; else critical. */
  bands: { good: 67, warn: 34 },
  /** Subtracted from account-health basis per active error state. */
  healthPenaltyPerError: 25,
} as const;

export type PulseConfig = typeof pulseV1;
