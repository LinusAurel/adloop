import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool, type PoolClient } from "pg";
import runMigrations from "node-pg-migrate";
import { uuidv7 } from "uuidv7";
import { clearRegistry, registerFamily } from "@/queue/registry";
import { echoFamily } from "@/queue/families/echo";
import { alwaysFailsFamily } from "@/queue/families/always-fails";
import { sleepsForeverFamily } from "@/queue/families/sleeps-forever";
import { timeoutThenLateWriteFamily } from "@/queue/families/timeout-then-late-write";
import { syncThrowsFamily } from "@/queue/families/sync-throws";

/**
 * §8: "gegen eine echte Postgres-Instanz (Testcontainers oder ein zweiter
 * Compose-Dienst — deine Wahl, aber dokumentieren)". Choice: Testcontainers,
 * one real ephemeral postgres:16-alpine container per test file, migrated
 * with the same migrations/*.sql the app itself uses (not a parallel schema
 * definition that could drift). See DECISIONS.md.
 */
export interface TestDb {
  pool: Pool;
  databaseUrl: string;
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
    databaseUrl,
    tenantId,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}

/**
 * Second review, the most important test-rigor point: a barrier around two
 * calls that both go through the SAME `Pool` proves nothing about real
 * concurrency — `pg.Pool` may (and often does, for two calls issued back to
 * back) serialize them onto one physical connection, in which case the
 * "race" was never a race at all and the test would pass even if the code
 * under test had no concurrency handling whatsoever.
 *
 * This acquires two connections explicitly, identifies each one's backend
 * process via `pg_backend_pid()`, and asserts they differ — so a caller can
 * use `clientA`/`clientB` for the two sides of a barrier and know, not
 * assume, that it is exercising two distinct Postgres backends.
 */
export interface DistinctClients {
  clientA: PoolClient;
  pidA: number;
  clientB: PoolClient;
  pidB: number;
  release(): void;
}

export async function acquireTwoDistinctClients(pool: Pool): Promise<DistinctClients> {
  const clientA = await pool.connect();
  const clientB = await pool.connect();
  const pidResultA = await clientA.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pidResultB = await clientB.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pidA = pidResultA.rows[0]!.pid;
  const pidB = pidResultB.rows[0]!.pid;
  if (pidA === pidB) {
    clientA.release();
    clientB.release();
    throw new Error(
      "acquireTwoDistinctClients got the same Postgres backend pid twice — cannot prove a real concurrency race",
    );
  }
  return {
    clientA,
    pidA,
    clientB,
    pidB,
    release() {
      clientA.release();
      clientB.release();
    },
  };
}

/** Registers echo plus every test-only family — none of the latter are ever registered in worker/index.ts. */
export function registerTestFamilies(): void {
  clearRegistry();
  registerFamily(echoFamily);
  registerFamily(alwaysFailsFamily);
  registerFamily(sleepsForeverFamily);
  registerFamily(timeoutThenLateWriteFamily);
  registerFamily(syncThrowsFamily);
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
