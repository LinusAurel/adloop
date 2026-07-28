import { join } from "node:path";
import { runner as runMigrations } from "node-pg-migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./db-harness";

describe("migrations", () => {
  let db: TestDb;

  beforeAll(async () => {
    // startTestDb already runs the full migration set once.
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  // §2: "Migrationen sind idempotent und laufen nur vorwärts" — and §3's
  // seed must survive "mehrfacher Containerstart" without duplicating
  // anything. A "fehlender tragender Test" from the test audit: this had
  // only ever been checked manually (via a throwaway container during
  // development), never as part of the automated suite.
  it("running the full migration set a second time against an already-migrated database is a no-op", async () => {
    const before = await db.pool.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`);
    expect(before.rows.length).toBeGreaterThan(0);

    // Must not throw, and must not error out on any "already exists"
    // condition — node-pg-migrate itself decides there's nothing to run.
    await runMigrations({
      databaseUrl: db.databaseUrl,
      dir: join(__dirname, "..", "migrations"),
      direction: "up",
      migrationsTable: "schema_migrations",
      log: () => {},
    });

    const after = await db.pool.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`);
    expect(after.rows).toEqual(before.rows);

    // The idempotent seed (ON CONFLICT DO NOTHING, fixed UUIDs) must not
    // have been duplicated by the second run.
    const tenants = await db.pool.query(
      `SELECT count(*) AS n FROM tenant WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    expect(Number(tenants.rows[0].n)).toBe(1);

    const users = await db.pool.query(
      `SELECT count(*) AS n FROM app_user WHERE id = '00000000-0000-0000-0000-000000000002'`,
    );
    expect(Number(users.rows[0].n)).toBe(1);

    // And the schema is still fully usable afterward.
    await expect(db.pool.query(`SELECT 1 FROM run LIMIT 1`)).resolves.toBeDefined();
  });
});
