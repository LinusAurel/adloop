import { z } from "zod";
import { getPool } from "@/db/pool";
import { computeAndPersistSnapshots } from "@/metrics/snapshots";
import { insightComparisonWindows } from "@/meta/insight-sync";
import { HandlerError } from "../errors";
import type { JobFamilyDefinition } from "../types";

const InputSchema = z.object({
  metaAdAccountId: z.string().uuid(),
  syncRunId: z.string().uuid(),
  windowEnd: z.string().date(),
});

const ResultSchema = z.object({
  funnelSnapshotCount: z.number().int().nonnegative(),
  strainSnapshotCount: z.number().int().nonnegative(),
  windowsComputed: z.number().int().nonnegative(),
});

type Input = z.infer<typeof InputSchema>;
type Result = z.infer<typeof ResultSchema>;

/**
 * Triggered after a successful insight sync. Computes append-only score
 * snapshots for the standard comparison windows ending at the sync's
 * window_end. Idempotent under at-least-once delivery: each run inserts new
 * snapshot rows; readers take the newest for a given data_as_of.
 */
export const metricSnapshotComputeFamily: JobFamilyDefinition<Input, Result> = {
  name: "metric_snapshot_compute",
  inputSchema: InputSchema,
  resultSchema: ResultSchema,
  maxAttempts: 5,
  timeoutMs: 10 * 60 * 1_000,

  async handler(ctx) {
    const pool = getPool();
    const sync = await pool.query<{
      finished_at: Date | null;
      status: string;
      tenant_id: string;
    }>(
      `SELECT finished_at, status, tenant_id
       FROM insight_sync_run
       WHERE id = $1 AND tenant_id = $2`,
      [ctx.input.syncRunId, ctx.tenantId],
    );
    const row = sync.rows[0];
    if (!row || row.status !== "succeeded" || !row.finished_at) {
      throw new HandlerError(
        "SYNC_NOT_READY",
        "sync_not_ready_for_snapshots",
        true,
      );
    }

    const dataAsOf = row.finished_at;
    const windows = insightComparisonWindows(ctx.input.windowEnd);
    let funnelSnapshotCount = 0;
    let strainSnapshotCount = 0;

    for (const [index, window] of windows.entries()) {
      if (ctx.signal.aborted) {
        throw new HandlerError("CANCELLED", "cancelled", false);
      }
      await ctx.progress({
        state: "computing_snapshots",
        message: "metric_snapshot_window",
        percent: Math.round(((index + 1) / windows.length) * 100),
      });
      const result = await computeAndPersistSnapshots({
        pool,
        tenantId: ctx.tenantId,
        adAccountId: ctx.input.metaAdAccountId,
        windowStart: window.start,
        windowEnd: window.end,
        dataAsOf,
        sourceSyncRunIds: [ctx.input.syncRunId],
      });
      funnelSnapshotCount += result.funnelSnapshotIds.length;
      strainSnapshotCount += result.strainSnapshotIds.length;
    }

    return {
      funnelSnapshotCount,
      strainSnapshotCount,
      windowsComputed: windows.length,
    };
  },
};
