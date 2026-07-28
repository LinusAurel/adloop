import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { createSession } from "@/auth/session";
import { requireOwnedResource } from "@/auth/guard";
import type { TestDb } from "./db-harness";
import { startTestDb } from "./db-harness";

describe("tenant ownership guard", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await db.stop();
  });

  it("returns 404 for an object owned by another tenant", async () => {
    const tenantB = uuidv7();
    const runB = uuidv7();
    await db.pool.query(`INSERT INTO tenant (id, name) VALUES ($1, 'tenant-b')`, [tenantB]);
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input)
       VALUES ($1, $2, 'echo', 'queued', '{}'::jsonb)`,
      [runB, tenantB],
    );

    const sessionA = createSession(uuidv7(), db.tenantId);
    const response = await requireOwnedResource(db.pool, sessionA, "run", runB);

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({ error: "not_found" });
  });
});
