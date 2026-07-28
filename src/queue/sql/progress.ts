import type { Pool } from "pg";
import type { JobProgress, JobRow } from "../types";

/**
 * §4.8: every progress report also extends the lease. Fenced identically to
 * every other worker mutation (§4.4). Deliberately requires status =
 * 'claimed' only — once a cancel has been requested, progress reports are
 * no longer meaningful (and test case 6 requires that none land after the
 * cancel point).
 *
 * P1-1 (second review): also requires `lease_expires_at >= now()` — see
 * sql/heartbeat.ts for why a stale-but-not-yet-reaped lease must not be
 * writable.
 */
export async function writeProgress(
  db: Pool,
  params: { jobId: string; leaseToken: string; leaseMs: number; progress: JobProgress },
): Promise<JobRow | null> {
  const result = await db.query<JobRow>(
    `UPDATE job SET
       progress = $1::jsonb,
       lease_expires_at = now() + ($2 || ' milliseconds')::interval,
       updated_at = now()
     WHERE id = $3 AND lease_token = $4 AND status = 'claimed'
       AND lease_expires_at >= now()
     RETURNING *`,
    [JSON.stringify(params.progress), params.leaseMs, params.jobId, params.leaseToken],
  );
  return result.rows[0] ?? null;
}
