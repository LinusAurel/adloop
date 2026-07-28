import type { Pool } from "pg";
import { DEFAULT_CANCEL_ERROR } from "../types";

export type CancelOutcome =
  | { outcome: "cancelled_immediately" }
  | { outcome: "cancel_requested" }
  | { outcome: "already_terminal" };

/**
 * The control-plane side of cancellation (called from the API, not from a
 * worker). Second review correction: this does NOT carry a lease_token —
 * fencing is a worker-mutation concept (§4.4), and the API has no lease to
 * present. Exclusivity here comes purely from a compare-and-set on status.
 *
 *   queued | retry_scheduled -> cancelled            (never ran / waiting for retry)
 *   claimed                  -> cancel_requested      (running now; worker notices
 *                                                       at its next checkpoint, or
 *                                                       the reaper does it if the
 *                                                       worker dies — see sql/reap.ts)
 *
 * The 'claimed' branch races against a worker's own terminal write (see
 * sql/finalize.ts for why that matters for test case 7). Whichever UPDATE
 * commits first wins; the other affects zero rows and this function reports
 * "already_terminal" for it.
 */
export async function requestCancel(
  pool: Pool,
  params: { jobId: string; tenantId: string },
): Promise<CancelOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const direct = await client.query(
      `UPDATE job SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status IN ('queued', 'retry_scheduled')
       RETURNING run_id`,
      [params.jobId, params.tenantId],
    );
    const directJob = direct.rows[0] as { run_id: string } | undefined;
    if (directJob) {
      await client.query(
        `UPDATE run SET status = 'cancelled', error = $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(DEFAULT_CANCEL_ERROR), directJob.run_id],
      );
      await client.query("COMMIT");
      return { outcome: "cancelled_immediately" };
    }

    const requested = await client.query(
      `UPDATE job SET status = 'cancel_requested', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'claimed'
       RETURNING id`,
      [params.jobId, params.tenantId],
    );
    if (requested.rows[0]) {
      await client.query("COMMIT");
      // Wake the owning worker immediately instead of waiting on its heartbeat
      // interval — see queue/poll-loop.ts. Best-effort: the heartbeat loop is
      // the fallback if this notification is ever missed.
      await pool.query(`SELECT pg_notify('job_cancelled', $1)`, [params.jobId]);
      return { outcome: "cancel_requested" };
    }

    await client.query("ROLLBACK");
    return { outcome: "already_terminal" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
