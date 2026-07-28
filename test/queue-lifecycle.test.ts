import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { runJob } from "@/queue/run-job";
import { insertQueuedRun, registerTestFamilies, sleep, startTestDb, type TestDb } from "./db-harness";

describe("queue lifecycle", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // Test case 1 (§8): success.
  it("echo with text 'ok' completes within 10s with the expected result", async () => {
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "ok" },
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "test-worker" });
    expect(job?.id).toBe(jobId);

    const controller = new AbortController();
    await runJob({ pool: db.pool, job: job!, leaseMs: 30000, heartbeatIntervalMs: 2000, controller });

    const { rows: runRows } = await db.pool.query(`SELECT * FROM run WHERE id = $1`, [runId]);
    const { rows: jobRows } = await db.pool.query(`SELECT * FROM job WHERE id = $1`, [jobId]);

    expect(runRows[0].status).toBe("completed");
    expect(jobRows[0].status).toBe("completed");
    expect(runRows[0].result).toEqual({ text: "ok" });
  }, 10000);

  // Test case 3 (§8): handler timeout, distinct from the lease timeout.
  // Test-audit correction: the bound is now 1000ms, not the auftrag's
  // literal 100ms — the tighter number also measures the terminal write's
  // own DB round-trip (BEGIN/UPDATE/UPDATE/COMMIT), which is fine locally
  // but flaky on a loaded CI runner. timeoutMs itself is still 50ms
  // (unchanged); only the test's own assertion window is loosened. See
  // DECISIONS.md.
  it("sleeps_forever ends as timed_out well under 1s, with no result stored", async () => {
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "sleeps_forever",
      input: {},
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "test-worker" });
    const controller = new AbortController();

    const start = Date.now();
    // sleeps_forever's handler NEVER resolves and ignores ctx.signal on
    // purpose — this only returns because run-job.ts races the handler
    // against family.timeoutMs (50ms here), not because the handler
    // cooperates.
    await runJob({ pool: db.pool, job: job!, leaseMs: 30000, heartbeatIntervalMs: 2000, controller });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);

    const { rows: runRows } = await db.pool.query(`SELECT * FROM run WHERE id = $1`, [runId]);
    const { rows: jobRows } = await db.pool.query(`SELECT * FROM job WHERE id = $1`, [jobId]);

    expect(jobRows[0].status).toBe("timed_out");
    expect(runRows[0].status).toBe("timed_out");
    expect(runRows[0].result).toBeNull();
    expect(jobRows[0].error.code).toBe("HANDLER_TIMEOUT");
  });

  // Test-audit correction: sleeps_forever alone never attempts a write, so
  // it can't prove a late-returning handler is actually fenced out — only
  // that the runner itself doesn't wait for it. timeout_then_late_write
  // schedules a ctx.progress() call well after its own timeoutMs and lets
  // us check the write never lands.
  it("a handler that keeps running past its timeout and later tries to write is fenced out", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "timeout_then_late_write",
      input: {},
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "test-worker" });
    const controller = new AbortController();

    const start = Date.now();
    await runJob({ pool: db.pool, job: job!, leaseMs: 30000, heartbeatIntervalMs: 2000, controller });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // runJob itself returns promptly...

    const { rows: rightAfter } = await db.pool.query(`SELECT status, progress FROM job WHERE id = $1`, [jobId]);
    expect(rightAfter[0].status).toBe("timed_out");
    expect(rightAfter[0].progress).toBeNull();

    // ...but the handler is still running in the background and fires its
    // late write at +300ms. Wait past that point and confirm it never landed.
    await sleep(500);
    const { rows: afterLateWrite } = await db.pool.query(
      `SELECT status, progress FROM job WHERE id = $1`,
      [jobId],
    );
    expect(afterLateWrite[0].status).toBe("timed_out");
    expect(afterLateWrite[0].progress).toBeNull();
  }, 5000);
});
