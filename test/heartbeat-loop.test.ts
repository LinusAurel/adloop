import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextJob } from "@/queue/sql/claim";
import { heartbeat } from "@/queue/sql/heartbeat";
import { startHeartbeatLoop } from "@/queue/heartbeat-loop";
import type { JobRow } from "@/queue/types";
import { insertQueuedRun, registerTestFamilies, sleep, startTestDb, type TestDb } from "./db-harness";

describe("heartbeat loop (P1-5)", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // The core P1-5 fix: the old implementation was
  // `void heartbeat(...).then(...)` inside `setInterval` — a rejection had
  // no `.catch()`, becoming an unhandled promise rejection (which, under
  // Node, can crash the whole process). Injecting a heartbeatFn that always
  // rejects proves the loop swallows the error, aborts the controller, and
  // — critically — this test itself does not fail with an unhandled
  // rejection, which it would under the old code even with a fake pool.
  it("a rejecting heartbeat aborts the controller instead of becoming an unhandled rejection", async () => {
    const controller = new AbortController();
    let callCount = 0;
    const failingHeartbeat = async (): Promise<JobRow | null> => {
      callCount += 1;
      throw new Error("simulated connection loss");
    };

    const loop = startHeartbeatLoop({
      pool: db.pool,
      jobId: "irrelevant",
      leaseToken: "irrelevant",
      leaseMs: 1000,
      intervalMs: 20,
      controller,
      heartbeatFn: failingHeartbeat,
    });

    await sleep(80);
    loop.stop();

    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(controller.signal.aborted).toBe(true);
  });

  // The second half of P1-5: setInterval fires on a fixed schedule
  // regardless of whether the previous call finished, so a slow heartbeat
  // could overlap with the next one. The serial chain here must never allow
  // two heartbeat calls in flight at once, even when each call is slower
  // than the configured interval.
  it("never runs two heartbeats concurrently even when the underlying call is slower than the interval", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slowHeartbeat = async (): Promise<JobRow | null> => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(60); // slower than the 20ms interval below
      concurrent -= 1;
      return { status: "claimed" } as JobRow;
    };

    const controller = new AbortController();
    const loop = startHeartbeatLoop({
      pool: db.pool,
      jobId: "irrelevant",
      leaseToken: "irrelevant",
      leaseMs: 1000,
      intervalMs: 20,
      controller,
      heartbeatFn: slowHeartbeat,
    });

    await sleep(300);
    loop.stop();

    expect(maxConcurrent).toBe(1);
    expect(controller.signal.aborted).toBe(false);
  });

  // A "fehlende tragende Test" from the test audit: heartbeat renewal must
  // actually extend the lease against a real database, not just be assumed
  // from the SQL. Uses the real `heartbeat` primitive (no injection).
  it("genuinely extends lease_expires_at against the real database", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "x" },
    });
    const job = await claimNextJob(db.pool, { leaseMs: 300, workerId: "test-worker" });
    const leaseToken = job!.lease_token as string;

    const before = await db.pool.query<{ lease_expires_at: string }>(
      `SELECT lease_expires_at FROM job WHERE id = $1`,
      [jobId],
    );
    const beforeExpiry = new Date(before.rows[0]!.lease_expires_at).getTime();

    await sleep(150);
    const row = await heartbeat(db.pool, { jobId, leaseToken, leaseMs: 300 });
    expect(row).not.toBeNull();

    const after = await db.pool.query<{ lease_expires_at: string }>(
      `SELECT lease_expires_at FROM job WHERE id = $1`,
      [jobId],
    );
    const afterExpiry = new Date(after.rows[0]!.lease_expires_at).getTime();

    expect(afterExpiry).toBeGreaterThan(beforeExpiry);
  });
});
