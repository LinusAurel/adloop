import type { Pool } from "pg";
import { DEFAULT_CANCEL_ERROR, type JobRow } from "../types";

/**
 * §4.5: a 'claimed' job whose lease has expired is orphaned — its worker is
 * presumed dead or unreachable. Move it back to 'queued' so another worker
 * can pick it up. `attempts` is left untouched (it counts started attempts,
 * and the abandoned attempt already counted). No lease_token in the WHERE
 * clause: that is the point — the old owner is gone and cannot be fenced
 * against by token, only by the fact that its lease timed out.
 */
export async function requeueExpiredLeases(pool: Pool): Promise<JobRow[]> {
  const result = await pool.query<JobRow>(
    `UPDATE job SET
       status = 'queued',
       lease_token = NULL,
       lease_expires_at = NULL,
       claimed_by = NULL,
       updated_at = now()
     WHERE status = 'claimed' AND lease_expires_at < now()
     RETURNING *`,
  );
  return result.rows;
}

/**
 * Second review correction: 'cancel_requested' has the same orphan problem
 * as 'claimed' — if the worker that was asked to cancel dies before it
 * finalizes, nothing ever moves the job out of 'cancel_requested' and it is
 * stuck forever (test case 9). Requeuing it to 'queued' would be wrong: the
 * job was on its way to being cancelled, not merely interrupted, and a
 * fresh attempt was never asked for. So it goes straight to 'cancelled'.
 * lease_expires_at is still populated from the last claim/heartbeat, so it
 * doubles as the staleness clock here too.
 */
export async function reapOrphanedCancellations(pool: Pool): Promise<JobRow[]> {
  const result = await pool.query<JobRow>(
    `UPDATE job SET
       status = 'cancelled',
       lease_token = NULL,
       lease_expires_at = NULL,
       claimed_by = NULL,
       updated_at = now()
     WHERE status = 'cancel_requested' AND lease_expires_at < now()
     RETURNING *`,
  );
  for (const job of result.rows) {
    await pool.query(
      `UPDATE run SET status = 'cancelled', error = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(DEFAULT_CANCEL_ERROR), job.run_id],
    );
  }
  return result.rows;
}
