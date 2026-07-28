import type { Queryable } from "@/db/queryable";
import { sha256Canonical, sha256Text } from "@/lib/canonical-json";
import { resolveMetrics } from "@/metrics/resolve";
import { computeFunnelPosition } from "@/metrics/funnel-position";
import { computeCreativeStrain } from "@/metrics/creative-strain";

export interface ContextPacketInput {
  agentLocale: "de" | "en";
  contentLocale: string;
  windowStart: string;
  windowEnd: string;
  performance: {
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    reach: number | null;
    frequency: number | null;
    ctr: number | null;
    cpc: number | null;
    cpm: number | null;
    conversions: number | null;
    conversionValue: number | null;
    roas: number | null;
  };
  derived: {
    funnelPosition: string;
    funnelScore: number | null;
    dataGatePassed: boolean;
    dataGateReasons: string[];
    creativeStrain: string | null;
    creativeStrainScore: number | null;
  };
  nextStep: {
    cta: string | null;
    destinationUrl: string | null;
  };
  metricDefinitions: Array<{ name: string; definition: string }>;
}

/**
 * Markdown context packet (SPEC §6.6). Absolute date bounds, disclosed
 * formulas, metric definitions, next-step metadata. Includes agent_locale
 * and content_locale as facts (auftrag §0.8 / §5).
 */
export function buildContextPacketMarkdown(input: ContextPacketInput): string {
  const p = input.performance;
  const d = input.derived;
  const lines: string[] = [
    `# Context packet`,
    ``,
    `- Agent locale: ${input.agentLocale}`,
    `- Content locale: ${input.contentLocale}`,
    ``,
    `## Performance`,
    ``,
    `Performance window: ${input.windowStart} to ${input.windowEnd}`,
    `- Spend: ${fmt(p.spend)} · Conversions: ${fmt(p.conversions)} · ROAS: ${fmt(p.roas)}`,
    `- CPM: ${fmt(p.cpm)} · CPC: ${fmt(p.cpc)} · CTR: ${fmt(p.ctr)}`,
    `- Frequency: ${fmt(p.frequency)} · Impressions: ${fmt(p.impressions)} · Reach: ${fmt(p.reach)}`,
    `- Clicks: ${fmt(p.clicks)} · Conversion value: ${fmt(p.conversionValue)}`,
    ``,
    `## Derived`,
    ``,
    `- Funnel position: ${d.funnelPosition}`,
    `- Funnel score: ${fmt(d.funnelScore)}`,
    `- Data gate passed: ${d.dataGatePassed ? "yes" : "no"}`,
    `- Data gate reasons: ${d.dataGateReasons.length ? d.dataGateReasons.join(", ") : "none"}`,
    `- Creative strain: ${d.creativeStrain ?? "n/a"}`,
    `- Creative strain score: ${fmt(d.creativeStrainScore)}`,
    ``,
    `FPS note: Funnel position is account-normalized from net-new reach share,`,
    `conversion rate and ROAS for the selected period. Data gate failures yield`,
    `"insufficient data" instead of a fabricated score.`,
    ``,
    `## Definitions`,
    ``,
  ];
  for (const def of input.metricDefinitions) {
    lines.push(`- ${def.name} = ${def.definition}`);
  }
  lines.push(
    ``,
    `## Ad next-step metadata`,
    ``,
    `- CTA / next-step link: ${input.nextStep.destinationUrl ?? "n/a"}`,
    `- CTA label: ${input.nextStep.cta ?? "n/a"}`,
    ``,
    `## Instruction`,
    ``,
    `Use the context below as evidence. Return the playbook's raw output`,
    `without following any app-specific report template. Do not add a required`,
    `summary section, top-lines section, progress recap, or fixed output`,
    `structure unless the playbook's own process naturally calls for it.`,
  );
  return lines.join("\n");
}

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return String(value);
}

export const DEFAULT_METRIC_DEFINITIONS: ContextPacketInput["metricDefinitions"] = [
  {
    name: "Spend",
    definition: "Meta-reported media spend for the selected window.",
  },
  {
    name: "ROAS",
    definition: "Conversion value divided by spend for the configured conversion metric.",
  },
  {
    name: "CTR",
    definition: "All-click CTR as reported by Meta for the window (not link-click-only).",
  },
  {
    name: "Frequency",
    definition: "Impressions divided by reach for the selected window.",
  },
  {
    name: "Quality rankings",
    definition:
      "Meta comparative diagnostics. Treat as directional signals, not absolute scores.",
  },
];

/** Hash of the full model request (Fall 10): system + playbook + packet + user. */
export function computePromptHash(parts: {
  systemInstruction: string;
  playbookContent: string;
  contextPacket: string;
  userMessage: string;
}): string {
  return sha256Canonical({
    systemInstruction: parts.systemInstruction,
    playbookContent: parts.playbookContent,
    contextPacket: parts.contextPacket,
    userMessage: parts.userMessage,
  });
}

export async function loadAdvertiserContentLocale(
  db: Queryable,
  tenantId: string,
): Promise<string> {
  const result = await db.query<{ content_locale: string }>(
    `SELECT content_locale FROM advertiser
     WHERE tenant_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [tenantId],
  );
  return result.rows[0]?.content_locale ?? "de-DE";
}

export function emptyContextPacket(params: {
  agentLocale: "de" | "en";
  contentLocale: string;
  windowStart: string;
  windowEnd: string;
  dataGateReasons?: string[];
}): string {
  return buildContextPacketMarkdown({
    agentLocale: params.agentLocale,
    contentLocale: params.contentLocale,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    performance: {
      spend: null,
      impressions: null,
      clicks: null,
      reach: null,
      frequency: null,
      ctr: null,
      cpc: null,
      cpm: null,
      conversions: null,
      conversionValue: null,
      roas: null,
    },
    derived: {
      funnelPosition: "insufficient_data",
      funnelScore: null,
      dataGatePassed: false,
      dataGateReasons: params.dataGateReasons ?? ["no_metrics_selected"],
      creativeStrain: null,
      creativeStrainScore: null,
    },
    nextStep: { cta: null, destinationUrl: null },
    metricDefinitions: DEFAULT_METRIC_DEFINITIONS,
  });
}

/**
 * Build the context packet from Etappe-2/3 facts via resolveMetrics / *_as_of
 * at the run's dataAsOf. Missing data is a named gate reason, never silent n/a
 * without explanation (Review-8 P1-5).
 *
 * Optional targeting (Etappe 5): when metaAdAccountId / analysisWindow /
 * metaAdId / funnelSnapshot are supplied, the packet mirrors exactly what the
 * strategist UI showed. Omitted fields keep the Etappe-4 default (selected
 * account, rolling 30-day window from caller).
 */
export async function assembleContextPacket(
  pool: Queryable,
  params: {
    tenantId: string;
    agentLocale: "de" | "en";
    contentLocale: string;
    windowStart: string;
    windowEnd: string;
    metaAdAccountId?: string;
    metaAdId?: string;
    dataAsOf?: string;
    funnelSnapshot?: {
      id: string;
      score: number | null;
      gateStatus: string;
      gateReasons: string[];
      band: string | null;
      inputs: unknown;
      metricDefinitionId: string | null;
      metricDefinitionVersion: number | null;
      windowStart: string;
      windowEnd: string;
      dataAsOf: string;
    };
  },
): Promise<{ packet: string; dataAsOf: string | null; metricDefinitionVersion: number | null }> {
  let adAccountId = params.metaAdAccountId;
  if (!adAccountId) {
    const account = await pool.query<{ id: string }>(
      `SELECT id FROM meta_ad_account
       WHERE tenant_id = $1 AND selected = true
       ORDER BY updated_at DESC
       LIMIT 1`,
      [params.tenantId],
    );
    adAccountId = account.rows[0]?.id;
  }
  if (!adAccountId) {
    return {
      packet: emptyContextPacket({
        ...params,
        dataGateReasons: ["no_ad_account_selected"],
      }),
      dataAsOf: null,
      metricDefinitionVersion: null,
    };
  }

  let dataAsOf = params.dataAsOf ?? null;
  if (!dataAsOf) {
    const sync = await pool.query<{ finished_at: string }>(
      `SELECT finished_at::text AS finished_at
       FROM insight_sync_run
       WHERE tenant_id = $1
         AND meta_ad_account_id = $2
         AND status = 'succeeded'
         AND finished_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 1`,
      [params.tenantId, adAccountId],
    );
    dataAsOf = sync.rows[0]?.finished_at ?? null;
  }
  if (!dataAsOf) {
    return {
      packet: emptyContextPacket({
        ...params,
        dataGateReasons: ["no_sync_completed"],
      }),
      dataAsOf: null,
      metricDefinitionVersion: null,
    };
  }

  const resolved = await resolveMetrics({
    pool,
    tenantId: params.tenantId,
    adAccountId,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    dataAsOf,
  });

  const focusRow = params.metaAdId
    ? resolved.rows.find((row) => row.metaAdId === params.metaAdId)
    : null;

  const totals = focusRow
    ? {
        spend: focusRow.spend,
        impressions: focusRow.impressions,
        clicks: focusRow.clicks,
        reach: focusRow.reach,
        frequency: focusRow.frequency,
        numerator: focusRow.numerator,
        metaRoas: focusRow.metaRoas,
      }
    : resolved.accountTotals;

  const impressions = totals.impressions;
  const clicks = totals.clicks;
  const spend = totals.spend;
  const ctr = impressions > 0 ? clicks / impressions : null;
  const cpc = clicks > 0 && spend > 0 ? spend / clicks : null;
  const cpm = impressions > 0 && spend > 0 ? (spend / impressions) * 1000 : null;

  const gateReasons: string[] = [...resolved.gateReasons];
  let funnelPosition = "insufficient_data";
  let funnelScore: number | null = null;
  let creativeStrain: string | null = null;
  let creativeStrainScore: number | null = null;

  if (params.funnelSnapshot) {
    funnelScore = params.funnelSnapshot.score;
    funnelPosition =
      params.funnelSnapshot.gateStatus === "ok"
        ? (params.funnelSnapshot.band ?? "scored")
        : "insufficient_data";
    if (params.funnelSnapshot.gateStatus !== "ok") {
      gateReasons.push(...params.funnelSnapshot.gateReasons);
    }
  } else if (resolved.gateStatus === "ok" && resolved.rows.length > 0) {
    const funnel = computeFunnelPosition({
      rows: resolved.rows,
      metricDefinition: resolved.metricDefinition,
      accountCurrency: resolved.accountCurrency,
    });
    if (params.metaAdId) {
      const ad = funnel.ads.find((entry) => entry.metaAdId === params.metaAdId);
      if (ad) {
        funnelScore = ad.score;
        funnelPosition =
          ad.gateStatus === "ok" ? (ad.band as string) : "insufficient_data";
        if (ad.gateStatus !== "ok") gateReasons.push(...ad.gateReasons);
      } else {
        gateReasons.push(...funnel.gateReasons);
      }
    } else if (funnel.gateStatus === "ok" && funnel.ads.length > 0) {
      const scored = funnel.ads.filter((ad) => ad.score !== null && ad.band);
      if (scored.length > 0) {
        const mean =
          scored.reduce((sum, ad) => sum + (ad.score as number), 0) / scored.length;
        funnelScore = mean;
        const bands = scored.map((ad) => ad.band as string);
        const dominant = mode(bands) ?? "mixed";
        funnelPosition = dominant;
      } else {
        gateReasons.push(...funnel.gateReasons);
      }
    } else {
      gateReasons.push(...funnel.gateReasons);
    }
  }

  if (resolved.gateStatus === "ok" && resolved.rows.length > 0) {
    const strain = await computeCreativeStrain({
      pool,
      tenantId: params.tenantId,
      adAccountId,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      dataAsOf,
      metaAdIds: params.metaAdId
        ? [params.metaAdId]
        : resolved.rows.map((row) => row.metaAdId),
    });
    const strainScored = strain.ads.filter((ad) => ad.value !== null);
    if (strainScored.length > 0) {
      creativeStrainScore =
        strainScored.reduce((sum, ad) => sum + (ad.value as number), 0) /
        strainScored.length;
      creativeStrain =
        creativeStrainScore >= 0.6
          ? "elevated"
          : creativeStrainScore >= 0.3
            ? "moderate"
            : "low";
    } else {
      for (const ad of strain.ads) {
        gateReasons.push(...ad.gateReasons);
      }
    }
  }

  if (params.metaAdId && !focusRow) {
    gateReasons.push("missing_observations");
  }

  const dataGatePassed = gateReasons.length === 0 && resolved.gateStatus === "ok";
  if (!dataGatePassed && gateReasons.length === 0) {
    gateReasons.push(...resolved.gateReasons);
    if (gateReasons.length === 0) gateReasons.push("insufficient_data");
  }

  let adName: string | null = null;
  if (params.metaAdId) {
    const nameRow = await pool.query<{ name: string }>(
      `SELECT name FROM meta_ad_as_of($1::uuid, $2::timestamptz)
       WHERE meta_ad_id = $3
       LIMIT 1`,
      [params.tenantId, dataAsOf, params.metaAdId],
    );
    adName = nameRow.rows[0]?.name ?? null;
  }

  const definitions = [
    ...DEFAULT_METRIC_DEFINITIONS,
    {
      name: resolved.metricDefinition.label,
      definition: `Configured conversion metric id=${resolved.metricDefinition.id} version=${resolved.metricDefinition.version} (${resolved.metricDefinition.valueSource}); denominator=${resolved.metricDefinition.denominator ?? "none"}; configuredBy=${resolved.metricDefinition.configuredBy}.`,
    },
  ];

  const packetLines = buildContextPacketMarkdown({
    agentLocale: params.agentLocale,
    contentLocale: params.contentLocale,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    performance: {
      spend,
      impressions,
      clicks,
      reach: totals.reach,
      frequency: totals.frequency,
      ctr,
      cpc,
      cpm,
      conversions: totals.numerator,
      conversionValue:
        totals.metaRoas.value !== null && spend > 0
          ? totals.metaRoas.value * spend
          : null,
      roas: totals.metaRoas.value,
    },
    derived: {
      funnelPosition,
      funnelScore,
      dataGatePassed,
      dataGateReasons: [...new Set(gateReasons)],
      creativeStrain,
      creativeStrainScore,
    },
    nextStep: { cta: null, destinationUrl: null },
    metricDefinitions: definitions,
  });

  const headerExtras: string[] = [];
  if (params.metaAdId) {
    headerExtras.push(`- Meta ad id: ${params.metaAdId}`);
    if (adName) headerExtras.push(`- Meta ad name: ${adName}`);
  }
  headerExtras.push(`- Meta ad account id: ${adAccountId}`);
  headerExtras.push(`- dataAsOf: ${dataAsOf}`);
  headerExtras.push(
    `- Metric definition: ${resolved.metricDefinition.label} v${resolved.metricDefinition.version} (${resolved.metricDefinition.id})`,
  );
  if (params.funnelSnapshot) {
    headerExtras.push(`- Funnel snapshot id: ${params.funnelSnapshot.id}`);
  }

  const packet = packetLines.replace(
    `# Context packet\n\n`,
    `# Context packet\n\n${headerExtras.join("\n")}\n\n`,
  );

  return {
    packet,
    dataAsOf,
    metricDefinitionVersion: resolved.metricDefinition.version,
  };
}

function mode(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export function contextPacketContentHash(packet: string): string {
  return sha256Text(packet);
}
