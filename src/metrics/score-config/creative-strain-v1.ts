/**
 * Creative-strain weights and window split.
 *
 * These weights are a reasoned assumption, not a measurement. They need real
 * account data before they can be treated as calibrated. Changing them
 * requires a new versioned config — never an in-place edit of this object.
 */
export const creativeStrainV1 = {
  version: "creative_strain_v1",
  weights: {
    frequencyTrend: 0.4,
    ctrDecay: 0.4,
    netNewReachDecay: 0.2,
  },
  /** First vs second half of the evaluation window. */
  windowSplit: 0.5,
  minDaysPerHalf: 3,
} as const;

export type CreativeStrainConfig = typeof creativeStrainV1;
