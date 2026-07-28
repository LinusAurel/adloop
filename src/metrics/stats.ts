/** Linear interpolation percentile as in Postgres `percentile_cont`. */
export function percentileCont(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) {
    throw new Error("percentile_cont requires at least one value");
  }
  if (sortedAscending.length === 1) return sortedAscending[0]!;
  const clamped = Math.min(1, Math.max(0, p));
  const h = (sortedAscending.length - 1) * clamped;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sortedAscending[lo]!;
  const weight = h - lo;
  return sortedAscending[lo]! * (1 - weight) + sortedAscending[hi]! * weight;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("mean requires at least one value");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Population standard deviation (`stddev_pop`), not sample. */
export function stddevPop(values: readonly number[]): number {
  if (values.length === 0) throw new Error("stddev_pop requires at least one value");
  const m = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function winsorize(
  values: readonly number[],
  lowerP = 0.05,
  upperP = 0.95,
): { winsorized: number[]; lower: number; upper: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const lower = percentileCont(sorted, lowerP);
  const upper = percentileCont(sorted, upperP);
  return {
    lower,
    upper,
    winsorized: values.map((value) => Math.min(upper, Math.max(lower, value))),
  };
}

export function zScore(value: number, m: number, sd: number): number {
  return (value - m) / sd;
}
