import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { writeProgress } from "@/queue/sql/progress";
import { heartbeat } from "@/queue/sql/heartbeat";
import { scheduleRetry } from "@/queue/sql/retry";
import { finalizeJob } from "@/queue/sql/finalize";
import { requeueExpiredLeases, reapOrphanedCancellations } from "@/queue/sql/reap";
import { requestCancel } from "@/queue/sql/cancel";
import { insertQueuedRun, registerTestFamilies, startTestDb, type TestDb } from "./db-harness";

async function expireLease(db: TestDb, jobId: string): Promise<void> {
  await db.pool.query(`UPDATE job SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
}

describe("queue reaping and fencing", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // P1-1 (second review), and the test-audit correction: this must be
  // checked BEFORE the reaper ever runs, not only after. Without the
  // `lease_expires_at >= now()` guard on heartbeat/progress/retry/finalize,
  // a worker whose lease has technically expired — but whose row the
  // reaper hasn't touched yet — could still successfully renew or write,
  // resurrecting a lease that should already be dead.
  it("an expired-but-not-yet-reaped lease cannot be renewed, written to, retried, or finalized", async () => {
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "x" },
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });
    const leaseToken = job!.lease_token as string;

    await expireLease(db, jobId);

    // Deliberately no call to requeueExpiredLeases here — the row is still
    // formally 'claimed' with this exact token. Every mutation must still
    // be refused purely because the lease's own expiry has passed.
    const heartbeatResult = await heartbeat(db.pool, { jobId, leaseToken, leaseMs: 30000 });
    expect(heartbeatResult).toBeNull();

    const progressResult = await writeProgress(db.pool, {
      jobId,
      leaseToken,
      leaseMs: 30000,
      progress: { state: "x", code: "should_not_land", params: {}, percent: 50 },
    });
    expect(progressResult).toBeNull();

    const retryResult = await scheduleRetry(db.pool, {
      jobId,
      leaseToken,
      error: { code: "X", message: "x", retryable: true },
      backoffBaseMs: 10,
      backoffMaxMs: 20,
    });
    expect(retryResult).toBeNull();

    const finalizeResult = await finalizeJob(db.pool, {
      jobId,
      leaseToken,
      fromStatus: "claimed",
      outcome: { toStatus: "completed", result: { text: "should not land" } },
    });
    expect(finalizeResult).toBeNull();

    // Nothing above touched the row — it is exactly as it was, still
    // claimed, still holding the same (expired) token, waiting for the
    // reaper.
    const { rows } = await db.pool.query(
      `SELECT status, lease_token, progress FROM job WHERE id = $1`,
      [jobId],
    );
    expect(rows[0].status).toBe("claimed");
    expect(rows[0].lease_token).toBe(leaseToken);
    expect(rows[0].progress).toBeNull();

    // Cleanup: this row is left 'claimed' with an already-expired lease on
    // purpose (that's the whole point of the test), which would otherwise
    // poison every later test in this file — requeueExpiredLeases and
    // reapOrphanedCancellations both scan the job table globally, not
    // scoped to one jobId, so a leftover expired-claimed row here would be
    // swept up by a *later* test's own reap call and could win that test's
    // claimNextJob's ORDER BY (it has an earlier created_at), silently
    // handing that test the wrong job.
    await db.pool.query(`DELETE FROM run WHERE id = $1`, [runId]);
  });

  // Test case 4 (§8), one of the load-bearing cases: an orphaned lease is
  // requeued atomically, and the worker that used to hold it can no longer
  // write anything — fencing, not just "someone else claims it too".
  it("reclaims an orphaned lease and fences out the old worker's writes", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "x" },
    });

    const jobA = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });
    expect(jobA).not.toBeNull();
    const staleToken = jobA!.lease_token as string;

    // Simulate worker A going silent (crash, network partition, ...): force
    // its lease into the past instead of waiting out a real leaseMs.
    await expireLease(db, jobId);

    const { requeued } = await requeueExpiredLeases(db.pool);
    expect(requeued.map((j) => j.id)).toContain(jobId);

    const { rows: afterReap } = await db.pool.query(
      `SELECT status, lease_token, claimed_by, attempts FROM job WHERE id = $1`,
      [jobId],
    );
    expect(afterReap[0].status).toBe("queued");
    expect(afterReap[0].lease_token).toBeNull();
    expect(afterReap[0].claimed_by).toBeNull();
    expect(afterReap[0].attempts).toBe(1); // §4.5: attempts is untouched by reaping

    const jobB = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-b" });
    expect(jobB?.id).toBe(jobId);
    expect(jobB!.lease_token).not.toBe(staleToken);
    expect(jobB!.attempts).toBe(2);

    // Worker A, still holding the stale token, tries to write — every
    // mutation must be fenced out (§4.4: zero rows affected), now that
    // ANOTHER worker legitimately owns a fresh lease on the row.
    const staleProgress = await writeProgress(db.pool, {
      jobId,
      leaseToken: staleToken,
      leaseMs: 30000,
      progress: { state: "x", code: "stale_write", params: {}, percent: 50 },
    });
    expect(staleProgress).toBeNull();

    const staleFinalize = await finalizeJob(db.pool, {
      jobId,
      leaseToken: staleToken,
      fromStatus: "claimed",
      outcome: { toStatus: "completed", result: { text: "should never land" } },
    });
    expect(staleFinalize).toBeNull();

    // Confirm none of worker A's writes actually landed.
    const { rows: finalRows } = await db.pool.query(
      `SELECT status, progress, claimed_by FROM job WHERE id = $1`,
      [jobId],
    );
    expect(finalRows[0].status).toBe("claimed");
    expect(finalRows[0].claimed_by).toBe("worker-b");
    expect(finalRows[0].progress).toBeNull();
  });

  // Test case 9 (§8), added after the second adversarial review: a job
  // stuck in cancel_requested because its worker died must not be
  // requeued (that would run work nobody asked to retry) — it must resolve
  // to cancelled, via the same lease-expiry mechanism as case 4.
  it("reaps a stranded cancel_requested job to cancelled, not queued — no deadlock", async () => {
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "x" },
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });
    expect(job).not.toBeNull();

    const cancelOutcome = await requestCancel(db.pool, { jobId: job!.id, tenantId: db.tenantId });
    expect(cancelOutcome.outcome).toBe("cancel_requested");

    // Worker A was asked to cancel but dies before it finalizes.
    await expireLease(db, jobId);

    const reaped = await reapOrphanedCancellations(db.pool);
    expect(reaped.map((j) => j.id)).toContain(jobId);

    const { rows } = await db.pool.query(`SELECT status, lease_token, claimed_by FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].lease_token).toBeNull();
    expect(rows[0].claimed_by).toBeNull();

    const { rows: runRows } = await db.pool.query(`SELECT status FROM run WHERE id = $1`, [runId]);
    expect(runRows[0].status).toBe("cancelled");

    // Not stuck, and specifically not silently resurrected as new work.
    const claimAttempt = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-b" });
    expect(claimAttempt).toBeNull();
  });

  // P1-4 (second review): the per-row transactional rewrite of
  // reapOrphanedCancellations must stay correct when two reapers (e.g. two
  // worker processes) run at the same moment — no job double-reaped, none
  // left with job terminal but run not (the exact failure mode a
  // non-atomic two-statement version could produce if it crashed between
  // them).
  it("concurrent cancel-reaping never double-processes a job and never leaves job/run inconsistent", async () => {
    const jobA = await insertQueuedRun(db.pool, { tenantId: db.tenantId, family: "echo", input: { text: "a" } });
    const jobB = await insertQueuedRun(db.pool, { tenantId: db.tenantId, family: "echo", input: { text: "b" } });

    const claimedA = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });
    const claimedB = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-b" });
    await requestCancel(db.pool, { jobId: claimedA!.id, tenantId: db.tenantId });
    await requestCancel(db.pool, { jobId: claimedB!.id, tenantId: db.tenantId });
    await expireLease(db, claimedA!.id);
    await expireLease(db, claimedB!.id);

    const [resultX, resultY] = await Promise.all([
      reapOrphanedCancellations(db.pool),
      reapOrphanedCancellations(db.pool),
    ]);

    const allReapedIds = [...resultX, ...resultY].map((j) => j.id).sort();
    expect(allReapedIds).toEqual([jobA.jobId, jobB.jobId].sort());

    for (const jobId of [jobA.jobId, jobB.jobId]) {
      const { rows } = await db.pool.query(
        `SELECT j.status AS job_status, r.status AS run_status
         FROM job j JOIN run r ON r.id = j.run_id
         WHERE j.id = $1`,
        [jobId],
      );
      expect(rows[0].job_status).toBe("cancelled");
      expect(rows[0].run_status).toBe("cancelled");
    }
  });

  // P1-6 (second review): a job whose worker keeps crashing before ever
  // writing a terminal state must not be reclaimed forever. Once `attempts`
  // (incremented on every claim, including reclaims) reaches the family's
  // maxAttempts, the reaper dead-letters instead of requeuing — otherwise a
  // job with an unknown-outcome external effect could run indefinitely.
  it("a repeatedly-crashing worker exhausts maxAttempts and is dead-lettered, not requeued forever", async () => {
    // always_fails: maxAttempts = 3.
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "always_fails",
      input: {},
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: `crashed-worker-${attempt}` });
      expect(job?.attempts).toBe(attempt);
      // Simulate an immediate crash: no heartbeat, no terminal write, ever.
      await expireLease(db, jobId);

      const { requeued, deadLettered } = await requeueExpiredLeases(db.pool);
      if (attempt < 3) {
        expect(requeued.map((j) => j.id)).toContain(jobId);
        expect(deadLettered.map((j) => j.id)).not.toContain(jobId);
      } else {
        expect(deadLettered.map((j) => j.id)).toContain(jobId);
        expect(requeued.map((j) => j.id)).not.toContain(jobId);
      }
    }

    const { rows } = await db.pool.query(`SELECT status, attempts, error FROM job WHERE id = $1`, [jobId]);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].attempts).toBe(3);
    expect(rows[0].error.code).toBe("LEASE_EXPIRED");

    const { rows: runRows } = await db.pool.query(`SELECT status, error FROM run WHERE id = $1`, [runId]);
    expect(runRows[0].status).toBe("failed");
    expect(runRows[0].error.code).toBe("LEASE_EXPIRED");

    const { rows: deadLetterRows } = await db.pool.query(
      `SELECT * FROM job_dead_letter WHERE job_id = $1`,
      [jobId],
    );
    expect(deadLetterRows).toHaveLength(1);
    expect(deadLetterRows[0].error.code).toBe("LEASE_EXPIRED");
    expect(deadLetterRows[0].attempts).toBe(3);

    // Terminal — no longer claimable by anyone, however late they show up.
    const claimAttempt = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-late" });
    expect(claimAttempt).toBeNull();
  });
});
