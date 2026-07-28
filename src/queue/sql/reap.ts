import type { Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { getFamily } from "../registry";
import { DEFAULT_CANCEL_ERROR, LEASE_EXPIRED_ERROR, type JobRow } from "../types";

export interface ReapResult {
  requeued: JobRow[];
  deadLettered: JobRow[];
}

/**
 * §4.5: a 'claimed' job whose lease has expired is orphaned — its worker is
 * presumed dead or unreachable. No lease_token in the WHERE clause: that is
 * the point — the old owner is gone and cannot be fenced against by token,
 * only by the fact that its lease timed out.
 *
 * P1-6 (second review): reclaiming forever is not free. If a job keeps
 * getting claimed and its worker keeps dying before a terminal write lands,
 * `attempts` (incremented on every claim, including reclaims) eventually
 * reaches the family's `maxAttempts` — at that point re-queuing again would
 * let a job with an unknown-outcome external effect (Meta publish,
 * Etappe 6/7) run indefinitely. So an orphan whose attempts are already
 * exhausted is dead-lettered as 'failed' with LEASE_EXPIRED instead of
 * requeued. `attempts` is otherwise left untouched by requeuing — it counts
 * started attempts, and the abandoned attempt already counted.
 */
export async function requeueExpiredLeases(pool: Pool): Promise<ReapResult> {
  const candidates = await pool.query<{ id: string; family: string; attempts: number }>(
    `SELECT id, family, attempts FROM job WHERE status = 'claimed' AND lease_expires_at < now()`,
  );

  const requeued: JobRow[] = [];
  const deadLettered: JobRow[] = [];

  for (const candidate of candidates.rows) {
    const maxAttempts = getFamily(candidate.family)?.maxAttempts ?? 0;

    if (candidate.attempts >= maxAttempts) {
      const job = await deadLetterExpiredClaim(pool, candidate.id);
      if (job) deadLettered.push(job);
      continue;
    }

    const result = await pool.query<JobRow>(
      `UPDATE job SET
         status = 'queued',
         lease_token = NULL,
         lease_expires_at = NULL,
         claimed_by = NULL,
         updated_at = now()
       WHERE id = $1 AND status = 'claimed' AND lease_expires_at < now()
       RETURNING *`,
      [candidate.id],
    );
    if (result.rows[0]) requeued.push(result.rows[0]);
  }

  return { requeued, deadLettered };
}

async function deadLetterExpiredClaim(pool: Pool, jobId: string): Promise<JobRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jobResult = await client.query<JobRow>(
      `UPDATE job SET
         status = 'failed',
         error = $1::jsonb,
         lease_token = NULL,
         lease_expires_at = NULL,
         claimed_by = NULL,
         updated_at = now()
       WHERE id = $2 AND status = 'claimed' AND lease_expires_at < now()
       RETURNING *`,
      [JSON.stringify(LEASE_EXPIRED_ERROR), jobId],
    );
    const job = jobResult.rows[0];
    if (!job) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `UPDATE run SET status = 'failed', error = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(LEASE_EXPIRED_ERROR), job.run_id],
    );

    await client.query(
      `INSERT INTO job_dead_letter (id, tenant_id, job_id, family, input, error, attempts, moved_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now())`,
      [uuidv7(), job.tenant_id, job.id, job.family, JSON.stringify(job.input), JSON.stringify(LEASE_EXPIRED_ERROR), job.attempts],
    );

    await client.query("COMMIT");
    return job;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
 *
 * P1-4 (second review): the job status change and the run status change are
 * now one transaction per row, not two separate statements — a crash
 * between them used to be able to leave the job terminal ('cancelled') but
 * its run stuck at 'running' forever, since nothing revisits an already-
 * terminal job. Candidates are read first, then each is processed in its
 * own transaction whose UPDATE re-checks the same WHERE clause — safe if
 * two reapers (e.g. two worker processes) run concurrently, since only one
 * of them will find the row still matching by the time its UPDATE executes.
 */
export async function reapOrphanedCancellations(pool: Pool): Promise<JobRow[]> {
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM job WHERE status = 'cancel_requested' AND lease_expires_at < now()`,
  );

  const reaped: JobRow[] = [];
  for (const { id } of candidates.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const jobResult = await client.query<JobRow>(
        `UPDATE job SET
           status = 'cancelled',
           lease_token = NULL,
           lease_expires_at = NULL,
           claimed_by = NULL,
           updated_at = now()
         WHERE id = $1 AND status = 'cancel_requested' AND lease_expires_at < now()
         RETURNING *`,
        [id],
      );
      const job = jobResult.rows[0];
      if (job) {
        await client.query(
          `UPDATE run SET status = 'cancelled', error = $1::jsonb, updated_at = now() WHERE id = $2`,
          [JSON.stringify(DEFAULT_CANCEL_ERROR), job.run_id],
        );
        reaped.push(job);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return reaped;
}
