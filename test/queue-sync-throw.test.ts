import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { runJob } from "@/queue/run-job";
import { insertQueuedRun, registerTestFamilies, startTestDb, type TestDb } from "./db-harness";

describe("P1-2: synchronous handler throw", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // Before the fix, `family.handler(ctx)` throwing synchronously (see
  // families/sync-throws.ts) unwound runJob before it ever reached
  // `clearInterval(heartbeatTimer)` — the exception propagated straight out
  // of runJob (rejecting its returned promise) and the job was left stuck
  // on 'claimed' forever, with a leaked heartbeat interval continuously
  // renewing its lease so the reaper could never touch it either. The fix
  // (Promise.resolve().then(() => family.handler(ctx)), timers set up
  // before the call, cleanup in `finally`) makes this a normal, contained
  // failure instead.
  it("does not crash runJob and still reaches a terminal state", async () => {
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "sync_throws",
      input: {},
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "test-worker" });
    const controller = new AbortController();

    // Before the fix, this await would reject (the synchronous throw
    // propagating out of an async function becomes a rejection) instead of
    // resolving — failing this test outright.
    await runJob({ pool: db.pool, job: job!, leaseMs: 30000, heartbeatIntervalMs: 50, controller });

    const { rows: jobRows } = await db.pool.query(`SELECT status, error FROM job WHERE id = $1`, [jobId]);
    expect(jobRows[0].status).toBe("failed"); // not stuck on 'claimed'
    expect(jobRows[0].error.code).toBe("SYNC_THROW");

    const { rows: runRows } = await db.pool.query(`SELECT status FROM run WHERE id = $1`, [runId]);
    expect(runRows[0].status).toBe("failed");

    const { rows: deadLetterRows } = await db.pool.query(
      `SELECT * FROM job_dead_letter WHERE job_id = $1`,
      [jobId],
    );
    expect(deadLetterRows).toHaveLength(1);
  });
});
