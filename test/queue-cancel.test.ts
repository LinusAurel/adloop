import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { requestCancel } from "@/queue/sql/cancel";
import { runJob } from "@/queue/run-job";
import { insertQueuedRun, registerTestFamilies, sleep, startTestDb, type TestDb } from "./db-harness";

describe("queue cancellation", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // Test case 6 (§8): cancelling a running job takes effect within 2s, with
  // no further progress recorded past the cancel point and no retry.
  // heartbeatIntervalMs is the (slower, fallback) detection path here — no
  // job_cancelled LISTEN is wired up because this drives runJob directly
  // rather than through the full worker poll loop — so a pass here is a
  // conservative lower bound; the real worker (NOTIFY-driven) is faster.
  it("cancelling a running echo after step 2 ends cancelled within 2s, no further progress, no retry", async () => {
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "cancel-me" },
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });
    const controller = new AbortController();
    const runPromise = runJob({
      pool: db.pool,
      job: job!,
      leaseMs: 30000,
      heartbeatIntervalMs: 300,
      controller,
    });

    // Wait until step 2's progress (40%) is visible.
    for (;;) {
      const { rows } = await db.pool.query(`SELECT progress FROM job WHERE id = $1`, [jobId]);
      const progress = rows[0].progress as { percent: number } | null;
      if (progress && progress.percent >= 40) break;
      await sleep(30);
    }

    const cancelStart = Date.now();
    const cancelOutcome = await requestCancel(db.pool, { jobId: job!.id, tenantId: db.tenantId });
    expect(cancelOutcome.outcome).toBe("cancel_requested");

    await runPromise;
    const elapsed = Date.now() - cancelStart;
    expect(elapsed).toBeLessThan(2000);

    const { rows: jobRows } = await db.pool.query(
      `SELECT status, progress, attempts FROM job WHERE id = $1`,
      [jobId],
    );
    expect(jobRows[0].status).toBe("cancelled");
    expect(jobRows[0].progress.percent).toBe(40); // no progress recorded past the cancel point
    expect(jobRows[0].attempts).toBe(1); // no retry

    const { rows: runRows } = await db.pool.query(`SELECT status FROM run WHERE id = $1`, [runId]);
    expect(runRows[0].status).toBe("cancelled");
  }, 10000);

  // Extension to test case 6, requested after the second adversarial
  // review: cancelling a job that is waiting between retries must resolve
  // immediately, without being claimed (and thus run) again.
  it("cancelling a retry_scheduled job goes straight to cancelled without being claimed again", async () => {
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "always_fails",
      input: {},
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });
    const controller = new AbortController();
    await runJob({ pool: db.pool, job: job!, leaseMs: 30000, heartbeatIntervalMs: 2000, controller });

    const { rows: afterFirstAttempt } = await db.pool.query(`SELECT status FROM job WHERE id = $1`, [jobId]);
    expect(afterFirstAttempt[0].status).toBe("retry_scheduled");

    const cancelOutcome = await requestCancel(db.pool, { jobId, tenantId: db.tenantId });
    expect(cancelOutcome.outcome).toBe("cancelled_immediately");

    const { rows } = await db.pool.query(`SELECT status, attempts FROM job WHERE id = $1`, [jobId]);
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].attempts).toBe(1); // never claimed a second time

    // Even once its retry would have become due, it must not be claimable.
    await sleep(50);
    const claimAttempt = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-b" });
    expect(claimAttempt).toBeNull();

    const { rows: runRows } = await db.pool.query(`SELECT status FROM run WHERE id = $1`, [runId]);
    expect(runRows[0].status).toBe("cancelled");
  });
});
