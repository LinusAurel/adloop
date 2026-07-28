import { uuidv7 } from "uuidv7";
import { withTransaction, type Queryable } from "../../db/queryable";
import type { JobRow } from "../types";

/**
 * §4.3, verbatim: FOR UPDATE SKIP LOCKED so two workers never grab the same
 * row, and every timestamp comes from the database (`now()`), never the
 * application clock — otherwise the lease deadline depends on which
 * container's clock you ask.
 *
 * P2-2 (second review): the job claim and the `run.status = 'running'`
 * update are wrapped in one transaction — a crash between two separate
 * statements used to be able to leave a claimed job whose run still showed
 * 'queued' forever.
 *
 * Accepts a `Queryable` (Pool or PoolClient — see db/queryable.ts): passing
 * a `Pool` in production lets this function own the connection lifecycle;
 * a test that needs to prove two claims genuinely race on two distinct
 * Postgres backends passes an already-acquired, pid-identified `PoolClient`
 * instead.
 */
export async function claimNextJob(
  db: Queryable,
  params: { leaseMs: number; workerId: string },
): Promise<JobRow | null> {
  const leaseToken = uuidv7();
  return withTransaction(db, async (client) => {
    const result = await client.query<JobRow>(
      `UPDATE job SET
         status = 'claimed',
         lease_token = $1,
         lease_expires_at = now() + ($2 || ' milliseconds')::interval,
         claimed_by = $3,
         attempts = attempts + 1,
         updated_at = now()
       WHERE id = (
         SELECT id FROM job
         WHERE status IN ('queued', 'retry_scheduled')
           AND scheduled_for <= now()
         ORDER BY scheduled_for, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [leaseToken, params.leaseMs, params.workerId],
    );

    const job = result.rows[0];
    if (!job) return null;

    // Etappe 1 decision (DECISIONS.md): run.status becomes 'running' on
    // first claim and stays there through retries — from the caller's
    // point of view the run is in flight until a terminal write lands.
    // Guarded by status = 'queued' so this is a no-op on a reclaim after
    // retry_scheduled (already 'running').
    await client.query(`UPDATE run SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued'`, [
      job.run_id,
    ]);

    return job;
  });
}
