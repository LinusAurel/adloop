import type { Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { DEFAULT_CANCEL_ERROR, type JobError, type JobRow } from "../types";

export type FinalizeOutcome =
  | { toStatus: "completed"; result: unknown }
  | { toStatus: "failed"; error: JobError }
  | { toStatus: "timed_out"; error: JobError }
  | { toStatus: "cancelled"; error?: JobError };

/**
 * The only place a job is ever moved into a terminal status. Second review
 * correction: every terminal write is a strict compare-and-set on BOTH
 * status and lease_token, never a set/IN-list of acceptable prior statuses.
 *
 *   completed | failed | timed_out   <- fromStatus 'claimed'
 *   cancelled (worker's own finalize) <- fromStatus 'cancel_requested'
 *
 * Why 'cancel_requested' is not also an accepted prior status for
 * completed/failed/timed_out: that is exactly what makes test case 7 (the
 * terminal race) decidable. The race is between this call (WHERE status =
 * 'claimed') and the cancel API's claimed -> cancel_requested update (also
 * WHERE status = 'claimed', see sql/cancel.ts). Whichever UPDATE physically
 * commits first flips the row's status away from 'claimed' and the other
 * one affects zero rows — there is no ambiguity to resolve after the fact.
 * If a losing completion write happened to also match 'cancel_requested',
 * both writers could "win" simultaneously, which is exactly what §4.2 rules
 * out ("der erste terminale Übergang gewinnt, die anderen laufen ins
 * Leere").
 *
 * If cancellation wins the race above, the handler is expected to notice
 * (via ctx.signal) and call this function again with fromStatus
 * 'cancel_requested' to finalize as 'cancelled'. If the worker dies before
 * it gets that far, sql/reap.ts's reapOrphanedCancellations is the backstop
 * — it does not require a lease_token because by then the lease has expired
 * and there is no legitimate owner left to fence against.
 */
export async function finalizeJob(
  pool: Pool,
  params: {
    jobId: string;
    leaseToken: string;
    fromStatus: "claimed" | "cancel_requested";
    outcome: FinalizeOutcome;
  },
): Promise<JobRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const error =
      params.outcome.toStatus === "completed"
        ? null
        : (params.outcome.error ?? (params.outcome.toStatus === "cancelled" ? DEFAULT_CANCEL_ERROR : null));

    const jobResult = await client.query<JobRow>(
      `UPDATE job SET
         status = $1,
         error = $2::jsonb,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = now()
       WHERE id = $3 AND lease_token = $4 AND status = $5
       RETURNING *`,
      [params.outcome.toStatus, error ? JSON.stringify(error) : null, params.jobId, params.leaseToken, params.fromStatus],
    );

    const job = jobResult.rows[0];
    if (!job) {
      await client.query("ROLLBACK");
      return null; // fenced out — lease lost, or another terminal write already won
    }

    const runResult = params.outcome.toStatus === "completed" ? JSON.stringify(params.outcome.result) : null;
    const runError = params.outcome.toStatus === "completed" ? null : JSON.stringify(error);

    await client.query(
      `UPDATE run SET
         status = $1,
         result = COALESCE($2::jsonb, result),
         error = $3::jsonb,
         updated_at = now()
       WHERE id = $4`,
      [params.outcome.toStatus, runResult, runError, job.run_id],
    );

    if (params.outcome.toStatus === "failed") {
      await client.query(
        `INSERT INTO job_dead_letter (id, tenant_id, job_id, family, input, error, attempts, moved_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now())`,
        [uuidv7(), job.tenant_id, job.id, job.family, JSON.stringify(job.input), JSON.stringify(error), job.attempts],
      );
    }

    await client.query("COMMIT");
    return job;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
