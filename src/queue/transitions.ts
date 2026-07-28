import type { JobStatus } from "./types";

/**
 * The single source of truth for which job status transitions are legal.
 * §4.2 of the auftrag, corrected per the second adversarial review:
 *
 *   queued            -> claimed
 *   queued            -> cancelled            (cancel before claim)
 *   claimed           -> completed | failed | timed_out
 *   claimed           -> retry_scheduled       (retryable error, attempts < max)
 *   claimed           -> cancel_requested      (cancel while running)
 *   retry_scheduled   -> claimed               (scheduled_for reached)
 *   retry_scheduled   -> cancelled             (cancel while waiting to retry)
 *   cancel_requested  -> cancelled             (worker notices at a checkpoint,
 *                                                or the reaper does it if the
 *                                                worker died — see sql/reap.ts)
 *
 * This map is used for assertions and documentation. The actual atomicity
 * guarantee comes from the WHERE clause of each SQL statement in sql/*.ts,
 * not from this map — see sql/finalize.ts for why completed/failed/timed_out
 * are only ever reachable from 'claimed', never from 'cancel_requested'.
 */
export const ALLOWED_JOB_TRANSITIONS: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  queued: new Set<JobStatus>(["claimed", "cancelled"]),
  claimed: new Set<JobStatus>([
    "completed",
    "failed",
    "timed_out",
    "retry_scheduled",
    "cancel_requested",
  ]),
  retry_scheduled: new Set<JobStatus>(["claimed", "cancelled"]),
  cancel_requested: new Set<JobStatus>(["cancelled"]),
  completed: new Set<JobStatus>(),
  failed: new Set<JobStatus>(),
  timed_out: new Set<JobStatus>(),
  cancelled: new Set<JobStatus>(),
};

export function assertJobTransitionAllowed(from: JobStatus, to: JobStatus): void {
  if (!ALLOWED_JOB_TRANSITIONS[from].has(to)) {
    throw new Error(`illegal job transition: ${from} -> ${to}`);
  }
}
