import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { inFlightKey, startWorker } from "@/queue/poll-loop";
import { insertQueuedRun, registerTestFamilies, sleep, startTestDb, type TestDb } from "./db-harness";

describe("P2-4: inFlight tracking", () => {
  // The exact race the fix addresses (this worker's own reaper reclaiming
  // one of its own still-running jobs, then re-claiming it with a second
  // token while the first execution is still technically alive) is not
  // practically reproducible deterministically without adding a test-only
  // seam to poll-loop.ts's internals. What is tested here: (1) the building
  // block — two claims of the SAME job.id but different lease tokens must
  // produce distinct map keys, proven directly; (2) an integration-level
  // regression check that normal multi-job concurrency tracking still
  // behaves correctly (reaches the configured concurrency and drops back to
  // zero) after the keying change.
  it("produces distinct keys for the same jobId with different lease tokens", () => {
    const jobId = uuidv7();
    const tokenA = uuidv7();
    const tokenB = uuidv7();
    expect(inFlightKey(jobId, tokenA)).not.toBe(inFlightKey(jobId, tokenB));
    // And is stable / deterministic for the same inputs.
    expect(inFlightKey(jobId, tokenA)).toBe(inFlightKey(jobId, tokenA));
  });

  describe("normal concurrency tracking (regression)", () => {
    let db: TestDb;

    beforeAll(async () => {
      registerTestFamilies();
      db = await startTestDb();
    });

    afterAll(async () => {
      await db.stop();
    });

    it("tracks two concurrently-running distinct jobs and drops back to zero once both finish", async () => {
      await insertQueuedRun(db.pool, { tenantId: db.tenantId, family: "echo", input: { text: "one" } });
      await insertQueuedRun(db.pool, { tenantId: db.tenantId, family: "echo", input: { text: "two" } });

      const worker = startWorker({
        pool: db.pool,
        connectionString: db.databaseUrl,
        workerId: `worker-${uuidv7()}`,
        pollIntervalMs: 20,
        leaseMs: 30000,
        heartbeatIntervalMs: 5000,
        concurrency: 2,
        shutdownGraceMs: 2000,
      });

      try {
        let maxSeen = 0;
        for (let i = 0; i < 100; i++) {
          maxSeen = Math.max(maxSeen, worker.getInFlightCount());
          if (maxSeen === 2) break;
          await sleep(20);
        }
        expect(maxSeen).toBe(2);
      } finally {
        await worker.shutdown();
      }

      // shutdown() waits a bounded amount of time for aborted handlers to
      // actually settle (poll-loop.ts), but getInFlightCount() is
      // documented as diagnostic-only, not a hard real-time guarantee —
      // under heavy parallel test-suite load (many Testcontainers Postgres
      // instances competing for CPU) the final `.finally()` cleanup can
      // land a little after shutdown() itself resolves. Poll briefly
      // instead of asserting the exact instant, matching how a real caller
      // would use a diagnostic method anyway.
      let finalCount = worker.getInFlightCount();
      for (let i = 0; i < 50 && finalCount !== 0; i++) {
        await sleep(20);
        finalCount = worker.getInFlightCount();
      }
      expect(finalCount).toBe(0);
    }, 15000);
  });
});
