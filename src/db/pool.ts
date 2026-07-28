import { Pool } from "pg";
import { env } from "@/lib/env";

let sharedPool: Pool | null = null;

/**
 * The process-wide pool used by the Next.js app and the worker entrypoint.
 * Tests build their own pool against an ephemeral Testcontainers instance
 * instead of touching this singleton — see test/setup.ts.
 */
export function getPool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: env.DATABASE_URL });
  }
  return sharedPool;
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}
