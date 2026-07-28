/**
 * Timestamptz cutoffs for *_as_of reads.
 *
 * Postgres stores microsecond precision; JavaScript Date only has milliseconds.
 * Passing a truncated Date into `finished_at <= dataAsOf` excludes the sync
 * that produced the observations. Prefer the raw timestamptz text from Postgres
 * (or an unparsed API string). Never round a Date down.
 */
export type DataAsOf = string | Date;

/** Exact value for persistence / equality checks. Strings pass through. */
export function dataAsOfParam(dataAsOf: DataAsOf): string {
  if (typeof dataAsOf === "string") return dataAsOf;
  return dataAsOf.toISOString();
}

/**
 * Cutoff for `*_as_of` / `finished_at <= …` predicates.
 * Strings (from Postgres `::text`) pass through with full precision.
 * Dates are rounded UP by 1ms so millisecond truncation cannot exclude the
 * originating sync.
 */
export function dataAsOfCutoff(dataAsOf: DataAsOf): string {
  if (typeof dataAsOf === "string") return dataAsOf;
  return new Date(dataAsOf.getTime() + 1).toISOString();
}

/** Inclusive calendar dates from start to end (YYYY-MM-DD, UTC). */
export function eachDateInclusive(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Shift a YYYY-MM-DD calendar date by `days` (can be negative). */
export function addCalendarDays(date: string, days: number): string {
  const cursor = new Date(`${date}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function inclusiveDayCount(start: string, end: string): number {
  return eachDateInclusive(start, end).length;
}

/**
 * Previous period of equal inclusive length ending the day before `windowStart`.
 * Example: 30-day window 2026-06-21..2026-07-20 → previous 2026-05-22..2026-06-20.
 */
export function previousEqualWindow(
  windowStart: string,
  windowEnd: string,
): { start: string; end: string } {
  const length = inclusiveDayCount(windowStart, windowEnd);
  const end = addCalendarDays(windowStart, -1);
  const start = addCalendarDays(end, -(length - 1));
  return { start, end };
}

export interface MissingDateRange {
  missingStart: string;
  missingEnd: string;
}

/**
 * First contiguous gap in `expected` relative to `present`.
 * Returns null when coverage is complete.
 */
export function firstMissingDateRange(
  expected: readonly string[],
  present: ReadonlySet<string>,
): MissingDateRange | null {
  let missingStart: string | null = null;
  let missingEnd: string | null = null;
  for (const day of expected) {
    if (present.has(day)) {
      if (missingStart !== null) break;
      continue;
    }
    if (missingStart === null) missingStart = day;
    missingEnd = day;
  }
  if (missingStart === null || missingEnd === null) return null;
  return { missingStart, missingEnd };
}
