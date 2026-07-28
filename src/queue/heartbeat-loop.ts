import type { Pool } from "pg";
import { heartbeat } from "./sql/heartbeat";
import type { JobRow } from "./types";

export interface HeartbeatLoopHandle {
  stop(): void;
}

type HeartbeatFn = (
  pool: Pool,
  params: { jobId: string; leaseToken: string; leaseMs: number },
) => Promise<JobRow | null>;

/**
 * P1-5 (second review): a serial timer chain, not `setInterval`.
 * `setInterval` fires on a fixed schedule regardless of whether the
 * previous heartbeat's DB round-trip has finished — under a slow or
 * congested DB, two heartbeat writes for the same job could end up in
 * flight at once. Each tick here only schedules the next one after its own
 * heartbeat call has settled.
 *
 * It also never lets a rejected heartbeat become an unhandled promise
 * rejection (the original `void heartbeat(...).then(...)` had no
 * `.catch()` — under Node, an unhandled rejection can crash the whole
 * process by default). A failing heartbeat is treated the same as a lost
 * lease: abort the handler's signal, and stop trying — retrying
 * immediately against a DB that just failed is unlikely to help, and the
 * job will be reclaimed by the lease-expiry mechanism regardless.
 *
 * `heartbeatFn` is injectable for tests (see test/heartbeat-loop.test.ts) —
 * the real implementation is sql/heartbeat.ts's `heartbeat`.
 */
export function startHeartbeatLoop(params: {
  pool: Pool;
  jobId: string;
  leaseToken: string;
  leaseMs: number;
  intervalMs: number;
  controller: AbortController;
  heartbeatFn?: HeartbeatFn;
}): HeartbeatLoopHandle {
  const doHeartbeat = params.heartbeatFn ?? heartbeat;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const row = await doHeartbeat(params.pool, {
        jobId: params.jobId,
        leaseToken: params.leaseToken,
        leaseMs: params.leaseMs,
      });
      if (!row || row.status === "cancel_requested") {
        params.controller.abort();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[job ${params.jobId}] heartbeat failed, aborting handler and giving up on this lease:`, err);
      params.controller.abort();
      stopped = true;
      return;
    }
    if (!stopped) {
      timer = setTimeout(() => {
        void tick();
      }, params.intervalMs);
    }
  }

  timer = setTimeout(() => {
    void tick();
  }, params.intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
