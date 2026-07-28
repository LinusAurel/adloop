import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { createBarrier, insertQueuedRun, registerTestFamilies, startTestDb, type TestDb } from "./db-harness";

describe("queue concurrency", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // Test case 5 (§8), load-bearing: two calls to claimNextJob, synchronized
  // by a real barrier (both coroutines must reach it before either proceeds
  // to issue its UPDATE) so they race as close to simultaneously as
  // possible — not two calls issued one after another, which would make
  // the test pass for the wrong reason. FOR UPDATE SKIP LOCKED guarantees
  // the outcome is deterministic regardless of exact timing: exactly one
  // caller gets the job, the other gets null.
  it("exactly one of two simultaneous claimNextJob callers gets the job", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "race" },
    });

    const barrier = createBarrier(2);
    const [resultA, resultB] = await Promise.all([
      (async () => {
        await barrier.arrive();
        return claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });
      })(),
      (async () => {
        await barrier.arrive();
        return claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-b" });
      })(),
    ]);

    const winners = [resultA, resultB].filter((r) => r !== null);
    const losers = [resultA, resultB].filter((r) => r === null);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]!.id).toBe(jobId);

    // And no job is claimable a second time — there was only ever one job.
    const thirdAttempt = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-c" });
    expect(thirdAttempt).toBeNull();
  });
});
