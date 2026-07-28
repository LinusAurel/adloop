import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, requireOwnedResource } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { computeCreativeStrain } from "@/metrics/creative-strain";
import { computeFunnelPosition } from "@/metrics/funnel-position";
import { resolveMetrics } from "@/metrics/resolve";

const QuerySchema = z.object({
  metaAdAccountId: z.string().uuid(),
  windowStart: z.string().date(),
  windowEnd: z.string().date(),
  dataAsOf: z.string().datetime({ offset: true }).optional(),
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

  const dataAsOf = parsed.data.dataAsOf
    ? new Date(parsed.data.dataAsOf)
    : new Date();

  const resolved = await resolveMetrics({
    pool,
    tenantId: auth.session.tenantId,
    adAccountId: parsed.data.metaAdAccountId,
    windowStart: parsed.data.windowStart,
    windowEnd: parsed.data.windowEnd,
    dataAsOf,
  });

  const funnel = computeFunnelPosition({
    rows: resolved.rows,
    metricDefinition: resolved.metricDefinition,
    accountCurrency: resolved.accountCurrency,
  });

  const strain = await computeCreativeStrain({
    pool,
    tenantId: auth.session.tenantId,
    adAccountId: parsed.data.metaAdAccountId,
    windowStart: parsed.data.windowStart,
    windowEnd: parsed.data.windowEnd,
    dataAsOf,
    metaAdIds: resolved.rows.map((row) => row.metaAdId),
  });

  const strainByAd = new Map(strain.ads.map((ad) => [ad.metaAdId, ad]));
  const funnelByAd = new Map(funnel.ads.map((ad) => [ad.metaAdId, ad]));

  return NextResponse.json({
    metricDefinition: resolved.metricDefinition,
    accountCurrency: resolved.accountCurrency,
    accountTotals: resolved.accountTotals,
    resolveGate: {
      gateStatus: resolved.gateStatus,
      gateReasons: resolved.gateReasons,
    },
    funnel: {
      formulaVersion: funnel.formulaVersion,
      scoreConfigVersion: funnel.scoreConfigVersion,
      populationSize: funnel.populationSize,
      gateStatus: funnel.gateStatus,
      gateReasons: funnel.gateReasons,
      minSpend: funnel.minSpend,
      accountCurrency: funnel.accountCurrency,
    },
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
