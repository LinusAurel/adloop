import type { Queryable } from "@/db/queryable";
import { sha256Canonical, sha256Text } from "@/lib/canonical-json";

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
      dataGateReasons: ["no_metrics_selected"],
      creativeStrain: null,
      creativeStrainScore: null,
    },
    nextStep: { cta: null, destinationUrl: null },
    metricDefinitions: DEFAULT_METRIC_DEFINITIONS,
  });
}

export function contextPacketContentHash(packet: string): string {
  return sha256Text(packet);
}
