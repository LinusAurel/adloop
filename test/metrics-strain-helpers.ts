/** Shared pure helpers for creative-strain unit assertions in tests. */
export function clipRelativeForTest(value: number): number {
  const clipped = Math.min(1, Math.max(-1, value));
  return (clipped + 1) / 2;
}
