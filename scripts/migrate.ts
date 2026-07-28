import { join } from "node:path";
import { Client } from "pg";
import runMigrations from "node-pg-migrate";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run migrations");
}
const DATABASE_URL: string = process.env.DATABASE_URL;

// Fixed, arbitrary advisory lock key. Any single worker across any number
// of `web` replicas that starts at the same time will serialize on this —
// see docker-compose.yml (web runs this before `next start`).
const MIGRATION_LOCK_KEY = 727_001;

async function main(): Promise<void> {
  const lockClient = new Client({ connectionString: DATABASE_URL });
  await lockClient.connect();
  try {
    console.log("[migrate] acquiring advisory lock...");
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    console.log("[migrate] lock acquired, running migrations...");
    await runMigrations({
      databaseUrl: DATABASE_URL,
      dir: join(__dirname, "..", "migrations"),
      direction: "up",
      migrationsTable: "schema_migrations",
      verbose: true,
      log: (msg: string) => console.log(`[migrate] ${msg}`),
    });
    console.log("[migrate] done.");
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    await lockClient.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
