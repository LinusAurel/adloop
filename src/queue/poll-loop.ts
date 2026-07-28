import type { Pool } from "pg";
import { claimNextJob } from "./sql/claim";
import { releaseClaimWithoutCounting } from "./sql/release";
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
  /** Diagnostic only — how many jobs this worker currently believes it owns. */
  getInFlightCount(): number;
}

interface InFlight {
  controller: AbortController;
  promise: Promise<void>;
}

/**
 * P2-4 (second review): keyed by `${jobId}:${leaseToken}`, not just jobId.
 * If this worker's own reaper reclaims one of its own jobs (its lease
 * expired while runJob was still — wrongly, but possibly — running) and the
 * poll loop then claims that same job again with a fresh token, a map keyed
 * by jobId alone would let the second entry silently overwrite the first:
 * the old (still actually running, now fenced-out) execution stops being
 * tracked, `inFlight.size` under-counts real concurrency, and the old
 * execution's eventual `.finally()` cleanup would delete the *new* entry
 * out from under it.
 */
export function inFlightKey(jobId: string, leaseToken: string): string {
  return `${jobId}:${leaseToken}`;
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
        // NOTIFY only carries the jobId — abort every in-flight entry for
        // it (normally exactly one; see inFlightKey's doc comment for why
        // there could briefly be more than one under the P2-4 race).
        for (const [key, entry] of inFlight) {
          if (key.startsWith(`${payload}:`)) entry.controller.abort();
        }
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

    // P1-3 (second review): re-check right before claiming — shutdown() may
    // have flipped `shuttingDown` while the two reap calls above were in
    // flight.
    if (shuttingDown) return false;
    if (inFlight.size >= opts.concurrency) return false;

    const job = await claimNextJob(opts.pool, { leaseMs: opts.leaseMs, workerId: opts.workerId });
    if (!job) return false;

    // P1-3 (second review): and re-check again right after — a claim that
    // slipped through the instant shutdown began must be released
    // immediately, without counting it as a real attempt (the handler never
    // ran). claimNextJob already incremented `attempts`;
    // releaseClaimWithoutCounting decrements it back.
    if (shuttingDown) {
      await releaseClaimWithoutCounting(opts.pool, { jobId: job.id, leaseToken: job.lease_token as string });
      return false;
    }

    const controller = new AbortController();
    const key = inFlightKey(job.id, job.lease_token as string);
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
        inFlight.delete(key);
        wakeLoop();
      });

    inFlight.set(key, { controller, promise });
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
      // Give the abort a short, bounded moment to actually take effect
      // before shutdown() itself returns. A cooperative handler (echo's
      // abortable delay()) settles within milliseconds of being aborted; a
      // handler that ignores the signal entirely (sleeps_forever, by
      // design) will not, and that is fine — getInFlightCount() may still
      // report it, and the lease is what allows another worker to resume
      // it regardless. Without this wait, shutdown() could return with an
      // entry still technically in-flight for a few more microtasks purely
      // because its `.finally()` cleanup hadn't run yet, which is
      // observably wrong for anyone using getInFlightCount() right after
      // shutdown() resolves.
      await Promise.race([Promise.allSettled([...inFlight.values()].map((e) => e.promise)), sleep(1000)]);
    }

    const listener = await listenerPromise;
    await listener.close();
  }

  return { shutdown, getInFlightCount: () => inFlight.size };
}
