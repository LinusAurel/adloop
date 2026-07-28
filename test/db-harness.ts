import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import runMigrations from "node-pg-migrate";
import { uuidv7 } from "uuidv7";
import { clearRegistry, registerFamily } from "@/queue/registry";
import { echoFamily } from "@/queue/families/echo";
import { alwaysFailsFamily } from "@/queue/families/always-fails";
import { sleepsForeverFamily } from "@/queue/families/sleeps-forever";

/**
 * §8: "gegen eine echte Postgres-Instanz (Testcontainers oder ein zweiter
 * Compose-Dienst — deine Wahl, aber dokumentieren)". Choice: Testcontainers,
 * one real ephemeral postgres:16-alpine container per test file, migrated
 * with the same migrations/*.sql the app itself uses (not a parallel schema
 * definition that could drift). See DECISIONS.md.
 */
export interface TestDb {
  pool: Pool;
  tenantId: string;
  stop(): Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  const databaseUrl = container.getConnectionUri();

  await runMigrations({
    databaseUrl,
    dir: join(__dirname, "..", "migrations"),
    direction: "up",
    migrationsTable: "schema_migrations",
    log: () => {},
  });

  const pool = new Pool({ connectionString: databaseUrl });

  // A tenant distinct from the seeded one, so tests don't depend on (or
  // pollute) seed data.
  const tenantId = uuidv7();
  await pool.query(`INSERT INTO tenant (id, name) VALUES ($1, 'test-tenant')`, [tenantId]);

  return {
    pool,
    tenantId,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}

/** Registers all three job families — the two test-only ones are never registered in worker/index.ts. */
export function registerTestFamilies(): void {
  clearRegistry();
  registerFamily(echoFamily);
  registerFamily(alwaysFailsFamily);
  registerFamily(sleepsForeverFamily);
}

export async function insertQueuedRun(
  pool: Pool,
  params: { tenantId: string; family: string; input: unknown },
): Promise<{ runId: string; jobId: string }> {
  const runId = uuidv7();
  const jobId = uuidv7();
  await pool.query(
    `INSERT INTO run (id, tenant_id, kind, status, input, created_at, updated_at)
     VALUES ($1, $2, $3, 'queued', $4::jsonb, now(), now())`,
    [runId, params.tenantId, params.family, JSON.stringify(params.input)],
  );
  await pool.query(
    `INSERT INTO job (id, tenant_id, run_id, family, status, input, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, now(), now())`,
    [jobId, params.tenantId, runId, params.family, JSON.stringify(params.input)],
  );
  return { runId, jobId };
}

/** A synchronization barrier: every caller's arrive() blocks until `n` callers have all reached it. */
export function createBarrier(n: number): { arrive: () => Promise<void> } {
  let count = 0;
  let resolveAll!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  return {
    async arrive() {
      count += 1;
      if (count === n) resolveAll();
      await gate;
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
