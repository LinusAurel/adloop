import type { Queryable } from "../../db/queryable";
import type { JobRow } from "../types";

/**
 * Extends the lease independent of handler progress (§4.5). Allowed while
 * 'claimed' (normal operation) or 'cancel_requested' (the worker still owns
 * the job while it winds down after noticing a cancel). Fenced by
 * lease_token: if this affects 0 rows, the worker has lost the job — the
 * caller aborts the handler's signal and discards whatever it produces.
 *
 * P1-1 (second review): also requires `lease_expires_at >= now()`. Without
 * it, a worker that briefly lost its DB connection could come back after
 * its lease had already expired — but before the reaper got to the row —
 * and successfully renew a lease that should already be dead, resurrecting
 * a claim nobody else can safely contest anymore.
 */
export async function heartbeat(
  db: Queryable,
  params: { jobId: string; leaseToken: string; leaseMs: number },
): Promise<JobRow | null> {
  const result = await db.query<JobRow>(
    `UPDATE job SET
       lease_expires_at = now() + ($1 || ' milliseconds')::interval,
       updated_at = now()
     WHERE id = $2 AND lease_token = $3 AND status IN ('claimed', 'cancel_requested')
       AND lease_expires_at >= now()
     RETURNING *`,
    [params.leaseMs, params.jobId, params.leaseToken],
  );
  return result.rows[0] ?? null;
}
