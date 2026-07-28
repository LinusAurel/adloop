import type { NumeratorAggregation } from "./types";

export interface ActionObservation {
  actionType: string;
  /** True when a row exists for this type (including completeness count=0). */
  present: boolean;
  count: number;
  /** NULL when Meta omitted action_values for this type. */
  value: number | null;
}

export interface AggregatedNumerator {
  count: number | null;
  value: number | null;
}

/**
 * "Present" for coalesce/first_present: a stored row exists. Missing rows are
 * not the same as a reported zero (completeness tombstone with count=0).
 */
export function aggregateNumerator(
  observations: readonly ActionObservation[],
  actionTypes: readonly string[],
  mode: NumeratorAggregation,
): AggregatedNumerator {
  const byType = new Map(observations.map((row) => [row.actionType, row]));

  if (mode === "sum_disjoint") {
    let any = false;
    let count = 0;
    let valueSum = 0;
    let anyNullValue = false;
    for (const actionType of actionTypes) {
      const row = byType.get(actionType);
      if (!row?.present) continue;
      any = true;
      count += row.count;
      if (row.value === null) {
        anyNullValue = true;
      } else {
        valueSum += row.value;
      }
    }
    if (!any) return { count: null, value: null };
    return {
      count,
      // Any missing Meta value in the summed set makes the total unknowable.
      value: anyNullValue ? null : valueSum,
    };
  }

  // coalesce_aliases and first_present: first present type in array order wins.
  for (const actionType of actionTypes) {
    const row = byType.get(actionType);
    if (!row?.present) continue;
    return { count: row.count, value: row.value };
  }
  return { count: null, value: null };
}
