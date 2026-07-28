import { z } from "zod";

export const JOB_STATUSES = [
  "queued",
  "claimed",
  "retry_scheduled",
  "cancel_requested",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
]);

/** §4.7: the shape every job error carries. Only `retryable: true` is retried. */
export const JobErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type JobError = z.infer<typeof JobErrorSchema>;

/** §4.8: progress reports. percent is an integer 0..100. */
export const JobProgressSchema = z.object({
  state: z.string().min(1),
  message: z.string().min(1),
  percent: z.number().int().min(0).max(100),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

/**
 * What a handler receives. It never touches the database directly — every
 * effect goes through ctx so the fencing rule (§4.4) can't be bypassed.
 */
export interface JobContext<TInput> {
  readonly input: TInput;
  readonly signal: AbortSignal;
  progress(p: JobProgress): Promise<void>;
  isCancelled(): boolean;
}

export interface JobFamilyDefinition<TInput, TResult> {
  name: string;
  inputSchema: z.ZodType<TInput>;
  resultSchema: z.ZodType<TResult>;
  maxAttempts: number;
  timeoutMs: number;
  /**
   * Backoff overrides for §4.7's formula (default base 1000ms / cap 60000ms).
   * Only the test-only families use this, to keep retry tests fast.
   */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  handler: (ctx: JobContext<TInput>) => Promise<TResult>;
}

/** Type-erased form stored in the registry — see registry.ts for why. */
export type AnyJobFamilyDefinition = JobFamilyDefinition<unknown, unknown>;

export interface JobRow {
  id: string;
  tenant_id: string;
  run_id: string;
  family: string;
  status: JobStatus;
  input: unknown;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  claimed_by: string | null;
  progress: JobProgress | null;
  error: JobError | null;
  scheduled_for: string;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  tenant_id: string;
  kind: string;
  status: RunStatus;
  input: unknown;
  result: unknown;
  error: JobError | null;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_CANCEL_ERROR: JobError = {
  code: "CANCELLED",
  message: "run was cancelled",
  retryable: false,
};

/**
 * P1-6 (second review): used when a job's `attempts` has reached
 * `maxAttempts` purely through crashed/orphaned attempts (the reaper
 * reclaiming it, or a defensive check right after claim) rather than
 * through a handler actually returning a retryable error. Distinct from a
 * normal exhausted-retries failure so the dead-letter entry is honest about
 * why the job stopped: nobody knows whether the external effect happened.
 */
export const LEASE_EXPIRED_ERROR: JobError = {
  code: "LEASE_EXPIRED",
  message: "attempts exhausted after repeated lease expiry (worker crash or connectivity loss)",
  retryable: false,
};
