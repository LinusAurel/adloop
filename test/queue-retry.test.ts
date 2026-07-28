import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { runJob } from "@/queue/run-job";
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

  // Test case 2 (§8): retry, exhaustion, and dead-letter.
  it("always_fails is claimed exactly three times, ends failed, and is dead-lettered once", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "always_fails",
      input: {},
    });

    let claims = 0;
    // always_fails uses a 10/20ms backoff override, so this loop finishes
    // in well under a second even though it polls for scheduled_for.
    for (let attempt = 0; attempt < 3; attempt++) {
      let job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "test-worker" });
      while (!job) {
        await sleep(5);
        job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "test-worker" });
      }
      claims += 1;
      const controller = new AbortController();
      await runJob({ pool: db.pool, job, leaseMs: 30000, heartbeatIntervalMs: 2000, controller });
    }

    expect(claims).toBe(3);

    const { rows: jobRows } = await db.pool.query(`SELECT * FROM job WHERE id = $1`, [jobId]);
    expect(jobRows[0].status).toBe("failed");
    expect(jobRows[0].attempts).toBe(3);
    expect(JobErrorSchema.safeParse(jobRows[0].error).success).toBe(true);

    // A fourth claim attempt must find nothing — the job is terminal.
    const noMoreWork = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "test-worker" });
    expect(noMoreWork).toBeNull();

    const { rows: deadLetterRows } = await db.pool.query(
      `SELECT * FROM job_dead_letter WHERE job_id = $1`,
      [jobId],
    );
    expect(deadLetterRows).toHaveLength(1);
    expect(JobErrorSchema.safeParse(deadLetterRows[0].error).success).toBe(true);
    expect(deadLetterRows[0].attempts).toBe(3);
  }, 10000);
});
