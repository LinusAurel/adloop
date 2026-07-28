import type { Pool } from "pg";
import type { JobError, JobRow } from "../types";

/**
 * §4.7: scheduled_for = now() + min(base * 2^(attempts-1), max) + jitter(0..250ms).
 * `attempts` already reflects the attempt that just failed (claim increments
 * it). Fenced identically to every other worker mutation: only reachable
 * from 'claimed', with a lease_token match.
 */
export async function scheduleRetry(
  pool: Pool,
  params: {
    jobId: string;
    leaseToken: string;
    error: JobError;
    backoffBaseMs: number;
    backoffMaxMs: number;
  },
): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `UPDATE job SET
       status = 'retry_scheduled',
       error = $1::jsonb,
       lease_token = NULL,
       lease_expires_at = NULL,
       claimed_by = NULL,
       scheduled_for = now() + (
         least($2::float * power(2, attempts - 1), $3::float) + random() * 250
       || ' milliseconds')::interval,
       updated_at = now()
     WHERE id = $4 AND lease_token = $5 AND status = 'claimed'
     RETURNING *`,
    [JSON.stringify(params.error), params.backoffBaseMs, params.backoffMaxMs, params.jobId, params.leaseToken],
  );
  return result.rows[0] ?? null;
}
