// Pure limit math, no database and no clock — callers pass `now`. Split from the
// component so it can be tested exhaustively on its own.

/** Whether adding `by` to `used` stays within `limit`. `by` must be zero or positive. */
export function canAdd(used: number, by: number, limit: number): boolean {
  if (by < 0) return false;
  return used + by <= limit;
}

/** How much of a limit is still available, never below zero. */
export function remaining(used: number, limit: number): number {
  return Math.max(0, limit - used);
}

/** Whether a usage period that started at `periodStartMs` has rolled over by `now`. */
export function periodExpired(periodStartMs: number, now: number, periodDays?: number): boolean {
  if (periodDays === undefined) return false;
  return now - periodStartMs >= periodDays * 86_400_000;
}
