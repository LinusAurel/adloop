import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { claimNextJob } from "@/queue/sql/claim";
import { startWorker } from "@/queue/poll-loop";
import { JobErrorSchema } from "@/queue/types";
import { insertQueuedRun, registerTestFamilies, sleep, startTestDb, type TestDb } from "./db-harness";

describe("queue retry", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // Test case 2 (§8): retry, exhaustion, and dead-letter. Test-audit
  // correction: driven by a real worker (startWorker), not a loop that
  // manually calls claimNextJob/runJob three times and counts itself as
  // proof of autonomous retry — that only shows the primitives work when
  // invoked by hand exactly three times, not that a worker actually
  // discovers and re-runs a retry_scheduled job on its own via polling and
  // LISTEN/NOTIFY.
  it("a real worker autonomously claims always_fails exactly three times, ends failed, and dead-letters once", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "always_fails",
      input: {},
    });

    const worker = startWorker({
      pool: db.pool,
      connectionString: db.databaseUrl,
      workerId: `worker-${uuidv7()}`,
      pollIntervalMs: 20,
      leaseMs: 5000,
      heartbeatIntervalMs: 1000,
      concurrency: 2,
      shutdownGraceMs: 2000,
    });

    try {
      // always_fails uses a 10/20ms backoff override, so the worker should
      // reach the terminal 'failed' state in well under a second on its own.
      let status = "";
      for (let i = 0; i < 100 && status !== "failed"; i++) {
        await sleep(50);
        const { rows } = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [jobId]);
        status = rows[0]!.status;
      }
      expect(status).toBe("failed");
    } finally {
      await worker.shutdown();
    }

    const { rows: jobRows } = await db.pool.query(`SELECT * FROM job WHERE id = $1`, [jobId]);
    expect(jobRows[0].status).toBe("failed");
    expect(jobRows[0].attempts).toBe(3); // claimed exactly three times, autonomously
    expect(JobErrorSchema.safeParse(jobRows[0].error).success).toBe(true);

    // A fifth claim attempt (by anyone) must find nothing — the job is terminal.
    const noMoreWork = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "test-worker" });
    expect(noMoreWork).toBeNull();

    const { rows: deadLetterRows } = await db.pool.query(
      `SELECT * FROM job_dead_letter WHERE job_id = $1`,
      [jobId],
    );
    expect(deadLetterRows).toHaveLength(1);
    expect(JobErrorSchema.safeParse(deadLetterRows[0].error).success).toBe(true);
    expect(deadLetterRows[0].attempts).toBe(3);
  }, 15000);
});
