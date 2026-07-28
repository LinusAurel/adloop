import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { claimNextJob } from "@/queue/sql/claim";
import { releaseClaimWithoutCounting } from "@/queue/sql/release";
import { startWorker } from "@/queue/poll-loop";
import { insertQueuedRun, registerTestFamilies, sleep, startTestDb, type TestDb } from "./db-harness";

describe("P1-3: shutdown/claim race", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // Direct, deterministic unit test of the primitive the fix relies on:
  // a claim that must be released without counting decrements `attempts`
  // back to what it was before the claim, and returns the row to 'queued'
  // exactly like it never happened.
  it("releaseClaimWithoutCounting reverses a claim exactly, including attempts", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "x" },
    });

    const job = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });
    expect(job?.attempts).toBe(1);

    const released = await releaseClaimWithoutCounting(db.pool, {
      jobId,
      leaseToken: job!.lease_token as string,
    });
    expect(released).not.toBeNull();
    expect(released!.status).toBe("queued");
    expect(released!.attempts).toBe(0); // back to exactly as if never claimed
    expect(released!.lease_token).toBeNull();

    // Claimable again, and this time attempts increments from 0 -> 1, not
    // from some inflated count left over by the released attempt.
    const reclaimed = await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-b" });
    expect(reclaimed?.attempts).toBe(1);
  });

  it("is a no-op (fenced) if the lease token no longer matches", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "x" },
    });
    await claimNextJob(db.pool, { leaseMs: 30000, workerId: "worker-a" });

    // A syntactically valid but wrong UUID — a real stale token is always a
    // real UUID (uuidv7() output) that just doesn't match the current one;
    // a garbage string would fail Postgres's uuid cast before the fencing
    // comparison is even reached, which isn't the scenario being tested.
    const result = await releaseClaimWithoutCounting(db.pool, { jobId, leaseToken: uuidv7() });
    expect(result).toBeNull();

    const { rows } = await db.pool.query(`SELECT status, attempts FROM job WHERE id = $1`, [jobId]);
    expect(rows[0].status).toBe("claimed");
    expect(rows[0].attempts).toBe(1);
  });

  // Integration-level check: startWorker's loop always performs two real DB
  // round-trips (requeueExpiredLeases, reapOrphanedCancellations) before
  // its own pre-claim `shuttingDown` check — calling shutdown() essentially
  // synchronously right after startWorker() returns reliably wins that
  // race against real Postgres latency, so this job is expected to never
  // be claimed at all. What matters is the invariant, not the exact
  // interleaving: no claim is left stranded, and no attempt is counted for
  // work that never ran.
  it("a worker shut down immediately after starting never strands a claimed job", async () => {
    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "shutdown-race" },
    });

    const worker = startWorker({
      pool: db.pool,
      connectionString: db.databaseUrl,
      workerId: `worker-${uuidv7()}`,
      pollIntervalMs: 5,
      leaseMs: 30000,
      heartbeatIntervalMs: 1000,
      concurrency: 1,
      shutdownGraceMs: 200,
    });

    // No sleep here on purpose — we want shutdown() to have a real chance
    // of landing before, during, or right after the loop's first claim.
    await worker.shutdown();

    // Give the fenced release (if the race was hit) or the abort path a
    // brief moment to finish landing.
    await sleep(100);

    const { rows } = await db.pool.query(`SELECT status, attempts, claimed_by FROM job WHERE id = $1`, [
      jobId,
    ]);
    // Either it was never claimed at all (shuttingDown was already true
    // before the first claim attempt), or it was claimed and immediately
    // released without counting. What must never happen: left 'claimed'
    // with no worker ever having run it, or with attempts inflated by a
    // claim nobody is accountable for.
    expect(rows[0].status).toBe("queued");
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].claimed_by).toBeNull();
  });
});
