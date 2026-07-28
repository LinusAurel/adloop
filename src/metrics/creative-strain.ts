import type { Queryable } from "@/db/queryable";
import { creativeStrainV1 } from "./score-config/creative-strain-v1";
import { dataAsOfCutoff, type DataAsOf } from "./data-as-of";
import { CREATIVE_STRAIN_FORMULA_VERSION, type GateReason, type GateStatus } from "./types";

export interface CreativeStrainAdScore {
  metaAdId: string;
  gateStatus: GateStatus;
  gateReasons: GateReason[];
  value: number | null;
  components: {
    frequencyTrend: number | null;
    ctrDecay: number | null;
    netNewReachDecay: number | null;
  };
}

export interface CreativeStrainResult {
  formulaVersion: typeof CREATIVE_STRAIN_FORMULA_VERSION;
  scoreConfigVersion: string;
  ads: CreativeStrainAdScore[];
}

export function splitWindowHalves(
  windowStart: string,
  windowEnd: string,
  windowSplit = creativeStrainV1.windowSplit,
): { halfA: { start: string; end: string }; halfB: { start: string; end: string } } {
  const start = new Date(`${windowStart}T00:00:00.000Z`);
  const end = new Date(`${windowEnd}T00:00:00.000Z`);
  const days =
    Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const firstHalfDays = Math.max(1, Math.floor(days * windowSplit));
  const midEnd = new Date(start);
  midEnd.setUTCDate(midEnd.getUTCDate() + firstHalfDays - 1);
  const secondStart = new Date(midEnd);
  secondStart.setUTCDate(secondStart.getUTCDate() + 1);
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  return {
    halfA: { start: windowStart, end: iso(midEnd) },
    halfB: { start: iso(secondStart), end: windowEnd },
  };
}

function relativeChange(before: number, after: number): number | null {
  if (before === 0) return null;
  return (after - before) / before;
}

function clipToUnit(value: number): number {
  const clipped = Math.min(1, Math.max(-1, value));
  return (clipped + 1) / 2;
}

/** Exported for tests that must exercise the production clipping path. */
export function clipRelativeChange(value: number): number {
  return clipToUnit(value);
}

interface HalfWindowRow {
  meta_ad_id: string;
  reach: string;
  frequency: string;
  impressions: string;
}

interface DailyHalfRow {
  meta_ad_id: string;
  clicks: string;
  impressions: string;
  delivery_days: string;
}

interface NetNewHalfRow {
  meta_ad_id: string;
  status: string;
  reason: string | null;
  net_new_reach: string | null;
}

async function loadHalfWindows(
  pool: Queryable,
  tenantId: string,
  adAccountId: string,
  half: { start: string; end: string },
  dataAsOf: DataAsOf,
): Promise<Map<string, { reach: number; frequency: number; impressions: number }>> {
  const result = await pool.query<HalfWindowRow>(
    `SELECT w.meta_ad_id, w.reach::text, w.frequency::text, w.impressions::text
     FROM insight_window_as_of($1, $2::timestamptz) w
     JOIN insight_sync_run r
       ON r.id = w.sync_run_id AND r.tenant_id = $1
     WHERE r.meta_ad_account_id = $3
       AND w.window_start = $4::date
       AND w.window_end = $5::date
       AND w.is_cumulative = false`,
    [tenantId, dataAsOfCutoff(dataAsOf), adAccountId, half.start, half.end],
  );
  return new Map(
    result.rows.map((row) => [
      row.meta_ad_id,
      {
        reach: Number(row.reach),
        frequency: Number(row.frequency),
        impressions: Number(row.impressions),
      },
    ]),
  );
}

async function loadHalfCtr(
  pool: Queryable,
  tenantId: string,
  adAccountId: string,
  half: { start: string; end: string },
  dataAsOf: DataAsOf,
): Promise<Map<string, { ctr: number | null; deliveryDays: number }>> {
  const result = await pool.query<DailyHalfRow>(
    `SELECT
       d.meta_ad_id,
       SUM(d.clicks)::text AS clicks,
       SUM(d.impressions)::text AS impressions,
       COUNT(*) FILTER (WHERE d.impressions > 0)::text AS delivery_days
     FROM insight_daily_as_of($1, $2::timestamptz) d
     JOIN insight_sync_run r
       ON r.id = d.sync_run_id AND r.tenant_id = $1
     WHERE r.meta_ad_account_id = $3
       AND d.date BETWEEN $4::date AND $5::date
     GROUP BY d.meta_ad_id`,
    [tenantId, dataAsOfCutoff(dataAsOf), adAccountId, half.start, half.end],
  );
  return new Map(
    result.rows.map((row) => {
      const impressions = Number(row.impressions);
      const clicks = Number(row.clicks);
      return [
        row.meta_ad_id,
        {
          ctr: impressions > 0 ? clicks / impressions : null,
          deliveryDays: Number(row.delivery_days),
        },
      ];
    }),
  );
}

async function loadHalfNetNew(
  pool: Queryable,
  tenantId: string,
  half: { start: string; end: string },
  dataAsOf: DataAsOf,
  adIds: readonly string[],
): Promise<Map<string, { netNewReach: number | null; reason: GateReason | null }>> {
  const result = new Map<
    string,
    { netNewReach: number | null; reason: GateReason | null }
  >();
  for (const metaAdId of adIds) {
    const row = await pool.query<NetNewHalfRow>(
      `SELECT status, reason, net_new_reach::text
       FROM net_new_reach_as_of($1, $2, $3::date, $4::date, $5::timestamptz)`,
      [tenantId, metaAdId, half.start, half.end, dataAsOfCutoff(dataAsOf)],
    );
    const first = row.rows[0];
    result.set(metaAdId, {
      netNewReach:
        first?.status === "available" && first.net_new_reach !== null
          ? Number(first.net_new_reach)
          : null,
      reason:
        first?.reason === "cumulative_reach_missing"
          ? "cumulative_reach_missing"
          : null,
    });
  }
  return result;
}

export async function computeCreativeStrain(params: {
  pool: Queryable;
  tenantId: string;
  adAccountId: string;
  windowStart: string;
  windowEnd: string;
  dataAsOf: DataAsOf;
  metaAdIds: readonly string[];
}): Promise<CreativeStrainResult> {
  const { halfA, halfB } = splitWindowHalves(
    params.windowStart,
    params.windowEnd,
  );

  const [windowsA, windowsB, ctrA, ctrB, netA, netB] = await Promise.all([
    loadHalfWindows(
      params.pool,
      params.tenantId,
      params.adAccountId,
      halfA,
      params.dataAsOf,
    ),
    loadHalfWindows(
      params.pool,
      params.tenantId,
      params.adAccountId,
      halfB,
      params.dataAsOf,
    ),
    loadHalfCtr(
      params.pool,
      params.tenantId,
      params.adAccountId,
      halfA,
      params.dataAsOf,
    ),
    loadHalfCtr(
      params.pool,
      params.tenantId,
      params.adAccountId,
      halfB,
      params.dataAsOf,
    ),
    loadHalfNetNew(
      params.pool,
      params.tenantId,
      halfA,
      params.dataAsOf,
      params.metaAdIds,
    ),
    loadHalfNetNew(
      params.pool,
      params.tenantId,
      halfB,
      params.dataAsOf,
      params.metaAdIds,
    ),
  ]);

  const ads: CreativeStrainAdScore[] = params.metaAdIds.map((metaAdId) => {
    const gateReasons: GateReason[] = [];
    const wa = windowsA.get(metaAdId);
    const wb = windowsB.get(metaAdId);
    if (!wa || !wb) {
      gateReasons.push("window_not_synced");
    }
    const ca = ctrA.get(metaAdId);
    const cb = ctrB.get(metaAdId);
    const deliveryA = ca?.deliveryDays ?? 0;
    const deliveryB = cb?.deliveryDays ?? 0;
    if (
      deliveryA < creativeStrainV1.minDaysPerHalf ||
      deliveryB < creativeStrainV1.minDaysPerHalf
    ) {
      gateReasons.push("window_too_short");
    }

    const na = netA.get(metaAdId);
    const nb = netB.get(metaAdId);
    if (na?.reason === "cumulative_reach_missing" || nb?.reason === "cumulative_reach_missing") {
      gateReasons.push("cumulative_reach_missing");
    }

    let frequencyTrend: number | null = null;
    let ctrDecay: number | null = null;
    let netNewReachDecay: number | null = null;

    if (wa && wb) {
      frequencyTrend = relativeChange(wa.frequency, wb.frequency);
      const shareA =
        na?.netNewReach !== null &&
        na?.netNewReach !== undefined &&
        wa.reach > 0
          ? na.netNewReach / wa.reach
          : null;
      const shareB =
        nb?.netNewReach !== null &&
        nb?.netNewReach !== undefined &&
        wb.reach > 0
          ? nb.netNewReach / wb.reach
          : null;
      if (shareA !== null && shareB !== null) {
        // Decay: share falling means more strain → invert relative change.
        const change = relativeChange(shareA, shareB);
        netNewReachDecay = change === null ? null : -change;
      }
    }

    if (ca?.ctr !== null && ca?.ctr !== undefined && cb?.ctr !== null && cb?.ctr !== undefined) {
      const change = relativeChange(ca.ctr, cb.ctr);
      ctrDecay = change === null ? null : -change;
    }

    if (gateReasons.length > 0) {
      return {
        metaAdId,
        gateStatus: "insufficient_data",
        gateReasons: [...new Set(gateReasons)],
        value: null,
        components: { frequencyTrend, ctrDecay, netNewReachDecay },
      };
    }

    const weighted: Array<{ weight: number; value: number }> = [];
    if (frequencyTrend !== null) {
      weighted.push({
        weight: creativeStrainV1.weights.frequencyTrend,
        value: clipToUnit(frequencyTrend),
      });
    }
    if (ctrDecay !== null) {
      weighted.push({
        weight: creativeStrainV1.weights.ctrDecay,
        value: clipToUnit(ctrDecay),
      });
    }
    if (netNewReachDecay !== null) {
      weighted.push({
        weight: creativeStrainV1.weights.netNewReachDecay,
        value: clipToUnit(netNewReachDecay),
      });
    }

    if (weighted.length === 0) {
      return {
        metaAdId,
        gateStatus: "insufficient_data",
        gateReasons: ["no_variance"],
        value: null,
        components: { frequencyTrend, ctrDecay, netNewReachDecay },
      };
    }

    const weightSum = weighted.reduce((sum, part) => sum + part.weight, 0);
    const strain =
      100 *
      weighted.reduce((sum, part) => sum + part.weight * part.value, 0) /
      weightSum;

    return {
      metaAdId,
      gateStatus: "ok",
      gateReasons: [],
      value: strain,
      components: { frequencyTrend, ctrDecay, netNewReachDecay },
    };
  });

  return {
    formulaVersion: CREATIVE_STRAIN_FORMULA_VERSION,
    scoreConfigVersion: creativeStrainV1.version,
    ads,
  };
}
