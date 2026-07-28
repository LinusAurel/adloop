import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { runJob } from "@/queue/run-job";
import { insertQueuedRun, registerTestFamilies, startTestDb, type TestDb } from "./db-harness";

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
  it("sleeps_forever ends as timed_out well within 100ms, with no result stored", async () => {
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

    expect(elapsed).toBeLessThan(100);

    const { rows: runRows } = await db.pool.query(`SELECT * FROM run WHERE id = $1`, [runId]);
    const { rows: jobRows } = await db.pool.query(`SELECT * FROM job WHERE id = $1`, [jobId]);

    expect(jobRows[0].status).toBe("timed_out");
    expect(runRows[0].status).toBe("timed_out");
    expect(runRows[0].result).toBeNull();
    expect(jobRows[0].error.code).toBe("HANDLER_TIMEOUT");
  });
});
