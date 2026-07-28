import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { writeProgress } from "@/queue/sql/progress";
import { finalizeJob } from "@/queue/sql/finalize";
import { requeueExpiredLeases, reapOrphanedCancellations } from "@/queue/sql/reap";
import { requestCancel } from "@/queue/sql/cancel";
import { insertQueuedRun, registerTestFamilies, startTestDb, type TestDb } from "./db-harness";

describe("queue reaping and fencing", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
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
    await db.pool.query(`UPDATE job SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [
      jobId,
    ]);

    const reaped = await requeueExpiredLeases(db.pool);
    expect(reaped.map((j) => j.id)).toContain(jobId);

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
    // mutation must be fenced out (§4.4: zero rows affected).
    const staleProgress = await writeProgress(db.pool, {
      jobId,
      leaseToken: staleToken,
      leaseMs: 30000,
      progress: { state: "x", message: "stale write from worker A", percent: 50 },
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
    await db.pool.query(`UPDATE job SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [
      jobId,
    ]);

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
});
