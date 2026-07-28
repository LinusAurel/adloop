import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { createRun } from "@/queue/create-run";
import { createBarrier, registerTestFamilies, startTestDb, type TestDb } from "./db-harness";

describe("run idempotency", () => {
  let db: TestDb;

  beforeAll(async () => {
    registerTestFamilies();
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // Test case 8 (§8): same runId + same body twice -> one run, one job.
  it("posting the same runId with the same body twice creates exactly one run and one job", async () => {
    const runId = uuidv7();
    const params = { runId, tenantId: db.tenantId, family: "echo", input: { text: "idempotent" } };

    const first = await createRun(db.pool, params);
    expect(first.outcome).toBe("created");

    const second = await createRun(db.pool, params);
    expect(second.outcome).toBe("idempotent_replay");
    if (second.outcome === "idempotent_replay") {
      expect(second.runId).toBe(runId);
    }

    const { rows: runRows } = await db.pool.query(`SELECT * FROM run WHERE id = $1`, [runId]);
    expect(runRows).toHaveLength(1);
    const { rows: jobRows } = await db.pool.query(`SELECT * FROM job WHERE run_id = $1`, [runId]);
    expect(jobRows).toHaveLength(1);
  });

  // Test case 8 (§8): same runId + a different body -> 409-shaped conflict.
  it("the same runId with a different body is reported as a conflict, original body preserved", async () => {
    const runId = uuidv7();
    const first = await createRun(db.pool, {
      runId,
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "a" },
    });
    expect(first.outcome).toBe("created");

    const second = await createRun(db.pool, {
      runId,
      tenantId: db.tenantId,
      family: "echo",
      input: { text: "b" },
    });
    expect(second.outcome).toBe("conflict");

    const { rows } = await db.pool.query(`SELECT input FROM run WHERE id = $1`, [runId]);
    expect(rows[0].input).toEqual({ text: "a" });
  });

  it("truly concurrent duplicate submissions still create exactly one run and one job", async () => {
    const runId = uuidv7();
    const params = { runId, tenantId: db.tenantId, family: "echo", input: { text: "concurrent" } };

    const barrier = createBarrier(2);
    const [a, b] = await Promise.all([
      (async () => {
        await barrier.arrive();
        return createRun(db.pool, params);
      })(),
      (async () => {
        await barrier.arrive();
        return createRun(db.pool, params);
      })(),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(["created", "idempotent_replay"]);

    const { rows: runRows } = await db.pool.query(`SELECT * FROM run WHERE id = $1`, [runId]);
    expect(runRows).toHaveLength(1);
    const { rows: jobRows } = await db.pool.query(`SELECT * FROM job WHERE run_id = $1`, [runId]);
    expect(jobRows).toHaveLength(1);
  });

  it("rejects an unregistered job family without creating anything", async () => {
    const runId = uuidv7();
    const result = await createRun(db.pool, {
      runId,
      tenantId: db.tenantId,
      family: "not_a_real_family",
      input: {},
    });
    expect(result.outcome).toBe("unknown_family");

    const { rows } = await db.pool.query(`SELECT * FROM run WHERE id = $1`, [runId]);
    expect(rows).toHaveLength(0);
  });
});
