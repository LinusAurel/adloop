import { Pool } from "pg";
import { env } from "@/lib/env";

let sharedPool: Pool | null = null;
let testOverride: Pool | null = null;

/**
 * The process-wide pool used by the Next.js app and the worker entrypoint.
 * Tests build their own pool against an ephemeral Testcontainers instance
 * instead of touching this singleton — see test/setup.ts.
 *
 * Etappe 4 agent_turn (and other handlers) call getPool() from inside the
 * worker; tests that drive those handlers must install the testcontainer
 * pool via `setPoolForTests`.
 */
export function getPool(): Pool {
  if (testOverride) return testOverride;
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: env.DATABASE_URL });
  }
  return sharedPool;
}

export function setPoolForTests(pool: Pool | null): void {
  testOverride = pool;
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}
