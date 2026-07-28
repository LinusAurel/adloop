/**
 * Data-gate thresholds for funnel-position scoring.
 *
 * These are reasoned assumptions without calibration against production
 * traffic. minSpend is denominated in the ad account's currency with no FX
 * conversion — the same number means different things in EUR vs USD accounts.
 * Snapshots must record that currency beside any spend-gated result.
 */
export const dataGateV1 = {
  version: "data_gate_v1",
  /** Minimum window spend in the ad account's currency (no FX). */
  minSpend: 50,
  minImpressions: 1000,
  minPopulation: 8,
} as const;

export type DataGateConfig = typeof dataGateV1;
