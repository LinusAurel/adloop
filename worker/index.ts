import { uuidv7 } from "uuidv7";
import { env } from "../src/lib/env";
import { getPool } from "../src/db/pool";
import { ensureQueueBootstrapped } from "../src/queue/bootstrap";
import { startWorker } from "../src/queue/poll-loop";
import { startHealthServer } from "./health";

// §4.1 / registry.ts: at-least-once delivery — every registered handler
// must be idempotent. `always_fails` and `sleeps_forever` are registered
// only by the test harness (test/setup.ts), never here.
ensureQueueBootstrapped();

const pool = getPool();
const workerId = env.WORKER_ID ?? `worker-${uuidv7()}`;
const health = startHealthServer(env.WORKER_HEALTH_PORT);

const worker = startWorker({
  pool,
  connectionString: env.DATABASE_URL,
  workerId,
  pollIntervalMs: env.JOB_POLL_INTERVAL_MS,
  leaseMs: env.JOB_LEASE_MS,
  heartbeatIntervalMs: env.JOB_HEARTBEAT_INTERVAL_MS,
  concurrency: env.WORKER_CONCURRENCY,
  shutdownGraceMs: env.WORKER_SHUTDOWN_GRACE_MS,
});

// eslint-disable-next-line no-console
console.log(`[worker] ${workerId} started (concurrency=${env.WORKER_CONCURRENCY})`);

let shuttingDown = false;
async function handleSignal(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[worker] received ${signal}, shutting down gracefully...`);
  await worker.shutdown();
  health.close();
  await pool.end();
  // eslint-disable-next-line no-console
  console.log("[worker] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void handleSignal("SIGTERM"));
process.on("SIGINT", () => void handleSignal("SIGINT"));
