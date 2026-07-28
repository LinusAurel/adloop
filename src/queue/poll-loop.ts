import type { Pool } from "pg";
import { claimNextJob } from "./sql/claim";
import { requeueExpiredLeases, reapOrphanedCancellations } from "./sql/reap";
import { runJob } from "./run-job";
import { createListener, type Listener } from "./listener";

export interface WorkerOptions {
  pool: Pool;
  connectionString: string;
  workerId: string;
  pollIntervalMs: number;
  leaseMs: number;
  heartbeatIntervalMs: number;
  concurrency: number;
  shutdownGraceMs: number;
}

export interface WorkerHandle {
  shutdown(): Promise<void>;
}

interface InFlight {
  controller: AbortController;
  promise: Promise<void>;
}

/**
 * §4.9: a serial poll loop, not `setInterval` — a single iteration always
 * finishes (claim attempt, then either launch a job or sleep) before the
 * next one starts, so loop iterations never overlap. Concurrency comes from
 * running up to `concurrency` claimed jobs at once, tracked in `inFlight`,
 * not from overlapping the loop itself.
 */
export function startWorker(opts: WorkerOptions): WorkerHandle {
  const inFlight = new Map<string, InFlight>();
  let shuttingDown = false;
  let wake: (() => void) | undefined;

  function wakeLoop(): void {
    wake?.();
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });
  }

  const listenerPromise: Promise<Listener> = createListener(
    opts.connectionString,
    ["job_available", "job_cancelled"],
    (channel, payload) => {
      if (channel === "job_available") {
        wakeLoop();
      } else if (channel === "job_cancelled" && payload) {
        inFlight.get(payload)?.controller.abort();
      }
    },
  ).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker ${opts.workerId}] LISTEN connection failed, relying on polling only:`, err);
    // Return a no-op listener so the rest of the worker keeps functioning —
    // polling is the documented fallback (§4.9).
    return { close: async () => {} } satisfies Listener;
  });

  async function loopOnce(): Promise<boolean> {
    await requeueExpiredLeases(opts.pool);
    await reapOrphanedCancellations(opts.pool);

    if (inFlight.size >= opts.concurrency) return false;

    const job = await claimNextJob(opts.pool, { leaseMs: opts.leaseMs, workerId: opts.workerId });
    if (!job) return false;

    const controller = new AbortController();
    const promise = runJob({
      pool: opts.pool,
      job,
      leaseMs: opts.leaseMs,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      controller,
    })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[worker ${opts.workerId}] job ${job.id} crashed inside runJob:`, err);
      })
      .finally(() => {
        inFlight.delete(job.id);
        wakeLoop();
      });

    inFlight.set(job.id, { controller, promise });
    return true;
  }

  async function loop(): Promise<void> {
    while (!shuttingDown) {
      let claimedSomething: boolean;
      try {
        claimedSomething = await loopOnce();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[worker ${opts.workerId}] poll iteration failed:`, err);
        claimedSomething = false;
      }
      if (!claimedSomething) {
        await sleep(opts.pollIntervalMs);
      }
    }
  }

  const loopPromise = loop();

  async function shutdown(): Promise<void> {
    // §4.9 graceful shutdown: stop claiming, let in-flight jobs finish
    // within the grace period, and never mark anything complete that
    // isn't — the lease is what allows another worker to resume it.
    shuttingDown = true;
    wakeLoop();
    await loopPromise;

    const deadline = Date.now() + opts.shutdownGraceMs;
    while (inFlight.size > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await Promise.race([...inFlight.values()].map((e) => e.promise).concat(sleep(Math.min(200, remaining))));
    }
    if (inFlight.size > 0) {
      for (const entry of inFlight.values()) entry.controller.abort();
    }

    const listener = await listenerPromise;
    await listener.close();
  }

  return { shutdown };
}
