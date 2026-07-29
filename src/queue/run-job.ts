import type { Pool } from "pg";
import { getFamily } from "./registry";
import { writeProgress } from "./sql/progress";
import { heartbeat } from "./sql/heartbeat";
import { finalizeJob } from "./sql/finalize";
import { scheduleRetry } from "./sql/retry";
import { startHeartbeatLoop } from "./heartbeat-loop";
import { JobCancelledError, normalizeError } from "./errors";
import { withTransaction } from "../db/queryable";
import {
  JobProgressSchema,
  LEASE_EXPIRED_ERROR,
  type JobContext,
  type JobProgress,
  type JobRow,
} from "./types";

export interface RunJobDeps {
  pool: Pool;
  job: JobRow;
  leaseMs: number;
  heartbeatIntervalMs: number;
  /** Owned by the caller so it can be aborted externally (NOTIFY, shutdown). */
  controller: AbortController;
}

type HandlerSettlement =
  | { kind: "result"; value: unknown }
  | { kind: "error"; value: unknown };

/**
 * Executes exactly one claimed job end to end: runs the handler, keeps the
 * lease alive via heartbeat, and writes the terminal outcome through the
 * fenced primitives in sql/*.ts.
 *
 * §4.6, load-bearing detail: a handler's Promise can't be cancelled. So a
 * hard timeout (`family.timeoutMs`) is enforced by racing the handler
 * against a timer, NOT by awaiting the handler and checking afterwards. If
 * the timer wins, we finalize as timed_out immediately and let the handler
 * keep running in the background — if it eventually tries to write via
 * ctx.progress, the fencing rule (lease already cleared) silently discards
 * it. This is exactly what `sleeps_forever` (an intentionally never-resolving
 * handler) is designed to prove.
 */
export async function runJob(deps: RunJobDeps): Promise<void> {
  const { pool, job, leaseMs, heartbeatIntervalMs, controller } = deps;
  const leaseToken = job.lease_token;
  if (!leaseToken) {
    throw new Error(`runJob called with job ${job.id} that has no lease_token`);
  }

  const family = getFamily(job.family);
  if (!family) {
    // Defensive: the API already rejects unknown families at submission
    // time (create-run.ts), so this only fires on a registry/deploy
    // mismatch. Never retryable — see §4.7.
    await finalizeJob(pool, {
      jobId: job.id,
      leaseToken,
      fromStatus: "claimed",
      outcome: {
        toStatus: "failed",
        error: {
          code: "UNKNOWN_FAMILY",
          message: `no handler registered for family "${job.family}"`,
          retryable: false,
        },
      },
    });
    return;
  }

  // P1-6 (second review): defense in depth alongside the reaper's own
  // maxAttempts check (sql/reap.ts) — if a job somehow reaches 'queued' or
  // 'retry_scheduled' with attempts already at the limit (it shouldn't,
  // under the current code paths, but claim itself doesn't know about
  // per-family maxAttempts), refuse to run the handler at all rather than
  // let a crash-prone job exceed its bound by one more attempt.
  if (job.attempts > family.maxAttempts) {
    await finalizeJob(pool, {
      jobId: job.id,
      leaseToken,
      fromStatus: "claimed",
      outcome: { toStatus: "failed", error: LEASE_EXPIRED_ERROR },
    });
    return;
  }

  const parsedInput = family.inputSchema.safeParse(job.input);
  if (!parsedInput.success) {
    await finalizeJob(pool, {
      jobId: job.id,
      leaseToken,
      fromStatus: "claimed",
      outcome: {
        toStatus: "failed",
        error: {
          code: "VALIDATION_ERROR",
          message: `job input failed schema validation: ${parsedInput.error.message}`,
          retryable: false,
        },
      },
    });
    return;
  }

  const ctx: JobContext<unknown> = {
    input: parsedInput.data,
    tenantId: job.tenant_id,
    runId: job.run_id,
    attempts: job.attempts,
    maxAttempts: family.maxAttempts,
    signal: controller.signal,
    isCancelled: () => controller.signal.aborted,
    progress: async (p: JobProgress) => {
      // P1-7 (second review): check locally before issuing the SQL write.
      // Without this, a progress call already in flight (or one the
      // handler makes just after being aborted) could still land and — via
      // writeProgress's lease_expires_at bump — resurrect a lease that
      // should be dying right now.
      if (controller.signal.aborted) return;
      const validated = JobProgressSchema.parse(p);
      const row = await writeProgress(pool, { jobId: job.id, leaseToken, leaseMs, progress: validated });
      if (!row) controller.abort();
    },
    withLease: async (write, options) =>
      withTransaction(pool, async (client) => {
        if (controller.signal.aborted && !options?.allowAfterCancellation) {
          return { acquired: false } as const;
        }
        const renewed = await heartbeat(client, {
          jobId: job.id,
          leaseToken,
          leaseMs,
        });
        if (
          !renewed ||
          (renewed.status === "cancel_requested" && !options?.allowAfterCancellation)
        ) {
          controller.abort();
          return { acquired: false } as const;
        }
        return { acquired: true, value: await write(client) } as const;
      }),
  };

  // P1-2 (second review): timers are created before the handler is ever
  // invoked, and the handler call itself is wrapped in
  // `Promise.resolve().then(...)` so a handler that throws SYNCHRONOUSLY
  // (e.g. a non-async function validating its input before returning a
  // promise) still produces a rejected promise instead of unwinding this
  // function and skipping the cleanup below — which used to leave the
  // heartbeat loop running forever, holding the job on 'claimed' and
  // blocking the reaper indefinitely.
  const heartbeatLoop = startHeartbeatLoop({
    pool,
    jobId: job.id,
    leaseToken,
    leaseMs,
    intervalMs: heartbeatIntervalMs,
    controller,
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutTimer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, family.timeoutMs);
  });

  const handlerPromise: Promise<HandlerSettlement> = Promise.resolve()
    .then(() => family.handler(ctx))
    .then(
      (value): HandlerSettlement => ({ kind: "result", value }),
      (value): HandlerSettlement => ({ kind: "error", value }),
    );

  let first: HandlerSettlement | { kind: "timeout" };
  try {
    first = await Promise.race([handlerPromise, timeoutPromise]);
  } finally {
    heartbeatLoop.stop();
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  if (first.kind === "timeout") {
    await finalizeJob(pool, {
      jobId: job.id,
      leaseToken,
      fromStatus: "claimed",
      outcome: {
        toStatus: "timed_out",
        error: {
          code: "HANDLER_TIMEOUT",
          message: `handler exceeded timeoutMs=${family.timeoutMs}`,
          retryable: false,
        },
      },
    });
    return;
  }

  if (first.kind === "result") {
    const parsedResult = family.resultSchema.safeParse(first.value);
    if (!parsedResult.success) {
      await finalizeJob(pool, {
        jobId: job.id,
        leaseToken,
        fromStatus: "claimed",
        outcome: {
          toStatus: "failed",
          error: {
            code: "VALIDATION_ERROR",
            message: `job result failed schema validation: ${parsedResult.error.message}`,
            retryable: false,
          },
        },
      });
      return;
    }
    // Fenced: if a concurrent cancel already won (status moved to
    // cancel_requested), this affects zero rows and the result is
    // discarded — see sql/finalize.ts.
    const resultData = parsedResult.data;
    const needsHuman =
      typeof resultData === "object" &&
      resultData !== null &&
      "status" in resultData &&
      (resultData as { status: unknown }).status === "needs_human_check";
    await finalizeJob(pool, {
      jobId: job.id,
      leaseToken,
      fromStatus: "claimed",
      outcome: {
        toStatus: "completed",
        result: resultData,
        ...(needsHuman ? { runStatus: "needs_human_check" as const } : {}),
      },
    });
    return;
  }

  // first.kind === "error"
  if (first.value instanceof JobCancelledError) {
    // The handler noticed cancellation itself. It may be finalizing from
    // 'claimed' (raced ahead of the API's cancel_requested write and lost —
    // fine, this call is then fenced out and a no-op) or, the expected
    // case, from 'cancel_requested' after the API already flipped it.
    await finalizeJob(pool, {
      jobId: job.id,
      leaseToken,
      fromStatus: "cancel_requested",
      outcome: { toStatus: "cancelled" },
    });
    return;
  }

  const error = normalizeError(first.value);
  if (error.retryable && job.attempts < family.maxAttempts) {
    await scheduleRetry(pool, {
      jobId: job.id,
      leaseToken,
      error,
      backoffBaseMs: family.backoffBaseMs ?? 1000,
      backoffMaxMs: family.backoffMaxMs ?? 60000,
    });
    return;
  }

  await finalizeJob(pool, {
    jobId: job.id,
    leaseToken,
    fromStatus: "claimed",
    outcome: { toStatus: "failed", error },
  });
}
