import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, requireOwnedResource } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { computeCreativeStrain } from "@/metrics/creative-strain";
import { computeFunnelPosition } from "@/metrics/funnel-position";
import { resolveMetrics } from "@/metrics/resolve";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
import {
  computeAndPersistSnapshots,
  dataAsOfIsLatestSync,
  latestSyncDataAsOf,
  readScoreSnapshots,
} from "@/metrics/snapshots";
import {
  CREATIVE_STRAIN_FORMULA_PREFIX,
  FUNNEL_POSITION_FORMULA_PREFIX,
  FUNNEL_POSITION_FORMULA_VERSION,
  type FunnelBand,
  type GateReason,
  type GateStatus,
} from "@/metrics/types";

const QuerySchema = z.object({
  metaAdAccountId: z.string().uuid(),
  windowStart: z.string().date(),
  windowEnd: z.string().date(),
  // Keep as raw string — parsing through Date drops microseconds.
  dataAsOf: z.string().min(1).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = QuerySchema.safeParse({
    metaAdAccountId: request.nextUrl.searchParams.get("metaAdAccountId"),
    windowStart: request.nextUrl.searchParams.get("windowStart"),
    windowEnd: request.nextUrl.searchParams.get("windowEnd"),
    dataAsOf: request.nextUrl.searchParams.get("dataAsOf") ?? undefined,
  });
  if (!parsed.success) return errorResponse(400, "validation_error");
  if (parsed.data.windowStart > parsed.data.windowEnd) {
    return errorResponse(400, "invalid_window");
  }

  const pool = getPool();
  const ownershipError = await requireOwnedResource(
    pool,
    auth.session,
    "metaAdAccount",
    parsed.data.metaAdAccountId,
  );
  if (ownershipError) return ownershipError;

  const latest = await latestSyncDataAsOf(
    pool,
    auth.session.tenantId,
    parsed.data.metaAdAccountId,
  );
  const dataAsOf = parsed.data.dataAsOf ?? latest ?? new Date().toISOString();
  const live = await dataAsOfIsLatestSync(pool, dataAsOf, latest);

  const resolved = await resolveMetrics({
    pool,
    tenantId: auth.session.tenantId,
    adAccountId: parsed.data.metaAdAccountId,
    windowStart: parsed.data.windowStart,
    windowEnd: parsed.data.windowEnd,
    dataAsOf,
  });

  let funnel: {
    formulaVersion: string;
    scoreConfigVersion: string;
    populationSize: number | null;
    gateStatus: GateStatus;
    gateReasons: GateReason[];
    minSpend: number | null;
    accountCurrency: string;
  };
  let funnelByAd: Map<
    string,
    {
      gateStatus: GateStatus;
      gateReasons: GateReason[];
      score: number | null;
      band: FunnelBand | null;
    }
  >;
  let strainByAd: Map<
    string,
    {
      gateStatus: GateStatus;
      gateReasons: GateReason[];
      value: number | null;
    }
  >;

  if (live) {
    const funnelLive = computeFunnelPosition({
      rows: resolved.rows,
      metricDefinition: resolved.metricDefinition,
      accountCurrency: resolved.accountCurrency,
    });
    const strainLive = await computeCreativeStrain({
      pool,
      tenantId: auth.session.tenantId,
      adAccountId: parsed.data.metaAdAccountId,
      windowStart: parsed.data.windowStart,
      windowEnd: parsed.data.windowEnd,
      dataAsOf,
      metaAdIds: resolved.rows.map((row) => row.metaAdId),
    });
    // Latest sync: live compute and persist (append-only).
    await computeAndPersistSnapshots({
      pool,
      tenantId: auth.session.tenantId,
      adAccountId: parsed.data.metaAdAccountId,
      windowStart: parsed.data.windowStart,
      windowEnd: parsed.data.windowEnd,
      dataAsOf,
      sourceSyncRunIds: [
        ...new Set(resolved.rows.flatMap((row) => row.syncRunIds)),
      ],
    });
    funnel = {
      formulaVersion: funnelLive.formulaVersion,
      scoreConfigVersion: funnelLive.scoreConfigVersion,
      populationSize: funnelLive.populationSize,
      gateStatus: funnelLive.gateStatus,
      gateReasons: funnelLive.gateReasons,
      minSpend: funnelLive.minSpend,
      accountCurrency: funnelLive.accountCurrency,
    };
    funnelByAd = new Map(
      funnelLive.ads.map((ad) => [
        ad.metaAdId,
        {
          gateStatus: ad.gateStatus,
          gateReasons: ad.gateReasons,
          score: ad.score,
          band: ad.band,
        },
      ]),
    );
    strainByAd = new Map(
      strainLive.ads.map((ad) => [
        ad.metaAdId,
        {
          gateStatus: ad.gateStatus,
          gateReasons: ad.gateReasons,
          value: ad.value,
        },
      ]),
    );
  } else {
    // Historical dataAsOf: scores are facts from snapshots, not recomputed.
    // Do not pin to today's compiled formula version — a stored v1 must still
    // resolve after the constant moves to v2. Return the snapshot's version.
    const [funnelSnaps, strainSnaps] = await Promise.all([
      readScoreSnapshots({
        pool,
        tenantId: auth.session.tenantId,
        adAccountId: parsed.data.metaAdAccountId,
        windowStart: parsed.data.windowStart,
        windowEnd: parsed.data.windowEnd,
        dataAsOf,
        formulaPrefix: FUNNEL_POSITION_FORMULA_PREFIX,
        subjectIds: resolved.rows.map((row) => row.metaAdId),
      }),
      readScoreSnapshots({
        pool,
        tenantId: auth.session.tenantId,
        adAccountId: parsed.data.metaAdAccountId,
        windowStart: parsed.data.windowStart,
        windowEnd: parsed.data.windowEnd,
        dataAsOf,
        formulaPrefix: CREATIVE_STRAIN_FORMULA_PREFIX,
        subjectIds: resolved.rows.map((row) => row.metaAdId),
      }),
    ]);

    const anyFunnel = [...funnelSnaps.values()][0];
    funnel = {
      formulaVersion:
        anyFunnel?.formulaVersion ?? FUNNEL_POSITION_FORMULA_VERSION,
      scoreConfigVersion: anyFunnel?.scoreConfigVersion ?? "unknown",
      populationSize: anyFunnel?.populationSize ?? null,
      gateStatus: anyFunnel ? "ok" : "insufficient_data",
      gateReasons: anyFunnel ? [] : ["no_snapshot"],
      minSpend: null,
      accountCurrency: resolved.accountCurrency,
    };
    funnelByAd = new Map();
    strainByAd = new Map();
    for (const row of resolved.rows) {
      const snap = funnelSnaps.get(row.metaAdId);
      funnelByAd.set(
        row.metaAdId,
        snap
          ? {
              gateStatus: snap.gateStatus,
              gateReasons: snap.gateReasons,
              score: snap.value,
              band: (snap.band as FunnelBand | null | undefined) ?? null,
            }
          : {
              gateStatus: "insufficient_data",
              gateReasons: ["no_snapshot"],
              score: null,
              band: null,
            },
      );
      const strain = strainSnaps.get(row.metaAdId);
      strainByAd.set(
        row.metaAdId,
        strain
          ? {
              gateStatus: strain.gateStatus,
              gateReasons: strain.gateReasons,
              value: strain.value,
            }
          : {
              gateStatus: "insufficient_data",
              gateReasons: ["no_snapshot"],
              value: null,
            },
      );
    }
  }

  return NextResponse.json({
    metricDefinition: resolved.metricDefinition,
    accountCurrency: resolved.accountCurrency,
    accountTotals: resolved.accountTotals,
    resolveGate: {
      gateStatus: resolved.gateStatus,
      gateReasons: resolved.gateReasons,
      missingDateRange: resolved.missingDateRange,
    },
    dataAsOf,
    scoresFromSnapshot: !live,
    funnel,
    ads: resolved.rows.map((row) => {
      const funnelAd = funnelByAd.get(row.metaAdId);
      const strainAd = strainByAd.get(row.metaAdId);
      return {
        metaAdId: row.metaAdId,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        linkClicks: row.linkClicks,
        landingPageViews: row.landingPageViews,
        reach: row.reach,
        frequency: row.frequency,
        numerator: row.numerator,
        denominator: row.denominator,
        cvr: row.cvr,
        cpa: row.cpa,
        metaRoas: row.metaRoas,
        expectedValueRoas: row.expectedValueRoas,
        realizedValueRoas: row.realizedValueRoas,
        funnelPosition: funnelAd
          ? {
              gateStatus: funnelAd.gateStatus,
              gateReasons: funnelAd.gateReasons,
              score: funnelAd.score,
              band: funnelAd.band,
            }
          : null,
        creativeStrain: strainAd
          ? {
              gateStatus: strainAd.gateStatus,
              gateReasons: strainAd.gateReasons,
              value: strainAd.value,
            }
          : null,
      };
    }),
  });
}
