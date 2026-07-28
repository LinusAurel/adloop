import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import {
  acquireTwoDistinctClients,
  createBarrier,
  insertQueuedRun,
  registerTestFamilies,
  startTestDb,
  type TestDb,
} from "./db-harness";

describe("queue concurrency", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // Test case 5 (§8), load-bearing, tightened per the second review's test
  // audit: a barrier around two calls sharing one `Pool` proves nothing —
  // `pg.Pool` can (and often does) serialize such calls onto a single
  // physical connection, in which case there was never a real race and the
  // test would pass regardless of whether SKIP LOCKED worked at all. This
  // acquires two connections explicitly, proves via pg_backend_pid() that
  // they are two distinct Postgres backends, and only then races
  // claimNextJob across them through a real barrier (both coroutines reach
  // it before either issues its UPDATE). FOR UPDATE SKIP LOCKED guarantees
  // the outcome is deterministic regardless of exact timing: exactly one
  // caller gets the job, the other gets null.
  it("exactly one of two simultaneous claimNextJob callers gets the job — proven on two distinct Postgres backends", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "race" },
    });

    const { clientA, pidA, clientB, pidB, release } = await acquireTwoDistinctClients(db.pool);
    expect(pidA).not.toBe(pidB); // the actual proof, not an assumption

    try {
      const barrier = createBarrier(2);
      const [resultA, resultB] = await Promise.all([
        (async () => {
          await barrier.arrive();
          return claimNextJob(clientA, { leaseMs: 30000, workerId: "worker-a" });
        })(),
        (async () => {
          await barrier.arrive();
          return claimNextJob(clientB, { leaseMs: 30000, workerId: "worker-b" });
        })(),
      ]);

      const winners = [resultA, resultB].filter((r) => r !== null);
      const losers = [resultA, resultB].filter((r) => r === null);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(winners[0]!.id).toBe(jobId);
    } finally {
      release();
    }

    // And no job is claimable a second time — there was only ever one job.
    const thirdAttempt = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-c" });
    expect(thirdAttempt).toBeNull();
  });
});
