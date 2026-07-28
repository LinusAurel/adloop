import type { Pool } from "pg";
import type { JobRow } from "../types";

/**
 * P1-3 (second review): used only for the shutdown/claim race in
 * poll-loop.ts — a claim that completes just as the worker is shutting
 * down must not count as a real attempt (the handler never ran). This is
 * the mirror image of claimNextJob: it undoes exactly what claiming did,
 * including decrementing `attempts` back to what it was before the claim.
 * Fenced by lease_token like every other worker mutation.
 */
export async function releaseClaimWithoutCounting(
  pool: Pool,
  params: { jobId: string; leaseToken: string },
): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `UPDATE job SET
       status = 'queued',
       lease_token = NULL,
       lease_expires_at = NULL,
       claimed_by = NULL,
       attempts = attempts - 1,
       updated_at = now()
     WHERE id = $1 AND lease_token = $2 AND status = 'claimed'
     RETURNING *`,
    [params.jobId, params.leaseToken],
  );
  return result.rows[0] ?? null;
}
