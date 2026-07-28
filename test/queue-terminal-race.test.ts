import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { finalizeJob } from "@/queue/sql/finalize";
import { requestCancel } from "@/queue/sql/cancel";
import { createBarrier, insertQueuedRun, registerTestFamilies, startTestDb, type TestDb } from "./db-harness";

describe("queue terminal race", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // Test case 7 (§8), load-bearing: completion and a cancel request racing
  // on the same claimed job. Per sql/finalize.ts, the decision point is a
  // compare-and-set on status = 'claimed' shared by both writers (the
  // worker's completion write and the cancel API's claimed -> cancel_requested
  // write) — synchronized with a real barrier, not two sequential calls.
  // Exactly one lands; the other affects zero rows / is reported as already
  // terminal, and that answer is stable (repeated cancel-finalize attempts
  // never succeed twice).
  it("completing and cancel-requesting a claimed job concurrently: exactly one wins", async () => {
    const { runId, jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "race" },
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });
    const leaseToken = job!.lease_token as string;

    const barrier = createBarrier(2);
    const [completeResult, cancelResult] = await Promise.all([
      (async () => {
        await barrier.arrive();
        return finalizeJob(db.pool, {
          jobId,
          leaseToken,
          fromStatus: "claimed",
          outcome: { toStatus: "completed", result: { text: "done" } },
        });
      })(),
      (async () => {
        await barrier.arrive();
        return requestCancel(db.pool, { jobId, tenantId: db.tenantId });
      })(),
    ]);

    const { rows } = await db.pool.query(`SELECT status FROM job WHERE id = $1`, [jobId]);
    const finalStatus = rows[0].status as string;

    if (completeResult) {
      // The completion write won the race.
      expect(finalStatus).toBe("completed");
      expect(cancelResult.outcome).toBe("already_terminal");

      const { rows: runRows } = await db.pool.query(`SELECT status, result FROM run WHERE id = $1`, [runId]);
      expect(runRows[0].status).toBe("completed");
      expect(runRows[0].result).toEqual({ text: "done" });
    } else {
      // The cancel request won the race — completion affected zero rows.
      expect(completeResult).toBeNull();
      expect(finalStatus).toBe("cancel_requested");
      expect(cancelResult.outcome).toBe("cancel_requested");

      // The worker (still holding its lease) finalizes the cancellation —
      // this must succeed exactly once.
      const cancelFinalize = await finalizeJob(db.pool, {
        jobId,
        leaseToken,
        fromStatus: "cancel_requested",
        outcome: { toStatus: "cancelled" },
      });
      expect(cancelFinalize).not.toBeNull();

      const repeatedCancelFinalize = await finalizeJob(db.pool, {
        jobId,
        leaseToken,
        fromStatus: "cancel_requested",
        outcome: { toStatus: "cancelled" },
      });
      expect(repeatedCancelFinalize).toBeNull();

      const { rows: runRows } = await db.pool.query(`SELECT status FROM run WHERE id = $1`, [runId]);
      expect(runRows[0].status).toBe("cancelled");
    }

    // Either way, a redundant completion attempt after the fact must also
    // be a no-op — the terminal decision, once made, is final.
    const redundantComplete = await finalizeJob(db.pool, {
      jobId,
      leaseToken,
      fromStatus: "claimed",
      outcome: { toStatus: "completed", result: { text: "too late" } },
    });
    expect(redundantComplete).toBeNull();
  });
});
