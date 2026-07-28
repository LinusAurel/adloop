import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { startWorker } from "@/queue/poll-loop";
import { insertQueuedRun, registerTestFamilies, sleep, startTestDb, type TestDb } from "./db-harness";

describe("real worker restart (not manual)", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // The Docker Compose verification (§9.3) does this by hand with a real
  // container restart. The test audit asked for the equivalent as an
  // automated, always-run test: a real startWorker() instance claims and
  // starts a job, is then killed abruptly (its Pool is ended without a
  // graceful shutdown — no cooperative cancellation, exactly like a crash
  // or a SIGKILL, unlike a clean SIGTERM), and a second, independently
  // started worker instance must pick the job back up via the lease-expiry
  // + reaper mechanism and complete it — claimed_by genuinely changing and
  // attempts incrementing to prove a real reclaim happened, not a fluke.
  it("a job survives an abrupt worker crash and is completed by a second, independently-started worker", async () => {
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "restart" },
    });

    const poolA = new Pool({ connectionString: db.databaseUrl });
    startWorker({
      pool: poolA,
      connectionString: db.databaseUrl,
      workerId: "worker-a",
      pollIntervalMs: 20,
      leaseMs: 300,
      heartbeatIntervalMs: 80,
      concurrency: 1,
      shutdownGraceMs: 100,
    });

    // Wait until worker A has actually claimed the job (not just inserted it).
    let claimedByA = false;
    for (let i = 0; i < 100 && !claimedByA; i++) {
      await sleep(20);
      const { rows } = await db.pool.query<{ status: string; claimed_by: string | null }>(
        `SELECT status, claimed_by FROM job WHERE id = $1`,
        [jobId],
      );
      claimedByA = rows[0]!.status === "claimed" && rows[0]!.claimed_by === "worker-a";
    }
    expect(claimedByA).toBe(true);

    // Abrupt crash: sever the pool without going through worker.shutdown().
    // No cooperative cancellation happens — this is what makes it a crash
    // simulation rather than a graceful-shutdown test (queue-shutdown-race
    // and the Docker verification already cover the graceful path).
    await poolA.end();

    const poolB = new Pool({ connectionString: db.databaseUrl });
    const workerB = startWorker({
      pool: poolB,
      connectionString: db.databaseUrl,
      workerId: "worker-b",
      pollIntervalMs: 50,
      leaseMs: 5000,
      heartbeatIntervalMs: 1000,
      concurrency: 1,
      shutdownGraceMs: 500,
    });

    try {
      let status = "";
      for (let i = 0; i < 200 && status !== "completed"; i++) {
        await sleep(50);
        const { rows } = await db.pool.query<{ status: string }>(`SELECT status FROM run WHERE id = $1`, [runId]);
        status = rows[0]!.status;
      }
      expect(status).toBe("completed");

      const { rows } = await db.pool.query<{ claimed_by: string | null; attempts: number }>(
        `SELECT claimed_by, attempts FROM job WHERE run_id = $1`,
        [runId],
      );
      expect(rows[0]!.claimed_by).toBe("worker-b"); // claimed_by genuinely changed
      expect(rows[0]!.attempts).toBe(2); // one reclaim happened
    } finally {
      await workerB.shutdown();
      await poolB.end();
    }
  }, 20000);
});
