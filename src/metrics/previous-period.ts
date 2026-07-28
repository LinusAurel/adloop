import type { ResolveMetricsResult } from "./resolve";
import {
  previousEqualWindow,
  type MissingDateRange,
} from "./data-as-of";

export type ComparedNumber = {
  value: number | null;
  previous: number | null;
  changePct: number | null;
  reason?: "previous_period_incomplete" | "window_incomplete";
};

export function changePct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function compareNumber(
  current: number | null,
  previous: number | null,
  reason?: ComparedNumber["reason"],
): ComparedNumber {
  if (reason === "previous_period_incomplete") {
    return { value: current, previous: null, changePct: null, reason };
  }
  return {
    value: current,
    previous,
    changePct: changePct(current, previous),
    ...(reason ? { reason } : {}),
  };
}

export function previousWindowBounds(
  windowStart: string,
  windowEnd: string,
): { start: string; end: string } {
  return previousEqualWindow(windowStart, windowEnd);
}

/**
 * Whether daily coverage for `previous` is gapless for every ad that spent
 * or impressed in the current window. Partial coverage → previous is null
 * with previous_period_incomplete — no partial sums, no extrapolation
 * (same principle as window_incomplete).
 */
export function previousPeriodCoverage(
  current: ResolveMetricsResult,
  previous: ResolveMetricsResult,
): { complete: boolean; missingDateRange: MissingDateRange | null } {
  if (previous.gateReasons.includes("window_incomplete") || previous.missingDateRange) {
    return {
      complete: false,
      missingDateRange: previous.missingDateRange,
    };
  }

  const previousByAd = new Map(previous.rows.map((row) => [row.metaAdId, row]));
  for (const row of current.rows) {
    if (row.spend <= 0 && row.impressions <= 0) continue;
    const prior = previousByAd.get(row.metaAdId);
    if (!prior || !prior.windowComplete) {
      return {
        complete: false,
        missingDateRange: prior?.missingDateRange ?? null,
      };
    }
  }

  return { complete: true, missingDateRange: null };
}
