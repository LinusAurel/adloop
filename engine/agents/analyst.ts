// Stage 7 — Analyst/Mining (SPEC §3, two-part by design):
// (a) real insights read against the account, filtered to OUR campaign_id —
//     freshly paused ads physically deliver no data, so an empty result is
//     reported as „Konnektivität OK, noch keine Daten“, never as failure;
// (b) mining demo on data/fixtures/insights-demo.json, clearly labeled as
//     fixture data (UI badge „Demo-Daten“).
// Classification rules live in engine/skills/mining.md; this module is the
// deterministic implementation (thresholds against small-sample noise).

import fs from "node:fs";
import path from "node:path";
import { getInsights, type MetaInsightRow } from "../connectors/meta.ts";
import { parseAdName } from "../naming.ts";
import { ensureBrandSeed, newId, readCollection, setRunResult, upsert } from "../store.ts";
import type { Brand, Learning, Run } from "../types.ts";
import { endRun, logLine, startRun } from "./run.ts";

const AGENT = "Analyst";

// Thresholds per mining.md: below either, a ad is statistically noise.
export const MIN_SPEND_EUR = 20;
export const MIN_LEADS = 3;

// Lead action types per brand conversion goal (SPEC §4 mining.md):
// pixel standard event and its offsite_conversion twin.
export const LEAD_ACTION_TYPES = ["lead", "offsite_conversion.fb_pixel_lead"];

export type AdClassification = "winner" | "loser" | "insufficient_data";

export interface NormalizedAdRow {
  adId: string;
  adName: string;
  angleId?: string;
  assetId?: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  cpl: number | null;
}

export interface ClassifiedAdRow extends NormalizedAdRow {
  classification: AdClassification;
  reason: string;
}

export interface AnalysisResult {
  runId: string;
  source: "live" | "fixture";
  note: string;
  totals: { spend: number; leads: number; cpl: number | null };
  targetCpa: number;
  rows: ClassifiedAdRow[];
  learnings: Learning[];
  recommendation: string;
}

function toNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

// Graph API returns numbers as strings and leads inside an actions list.
// The list often contains BOTH 'lead' (aggregate) and
// 'offsite_conversion.fb_pixel_lead' (pixel subset) for the same conversions,
// so we take the first matching type by priority instead of summing —
// summing would double-count.
export function normalizeRow(row: MetaInsightRow): NormalizedAdRow {
  let leads = 0;
  for (const type of LEAD_ACTION_TYPES) {
    const match = (row.actions ?? []).find((a) => a.action_type === type);
    if (match) {
      leads = toNumber(match.value);
      break;
    }
  }
  const spend = toNumber(row.spend);
  const adName = row.ad_name ?? "";
  const parsed = parseAdName(adName);
  return {
    adId: row.ad_id ?? "",
    adName,
    angleId: parsed?.angleId,
    assetId: parsed?.assetId,
    spend,
    impressions: toNumber(row.impressions),
    clicks: toNumber(row.clicks),
    leads,
    cpl: leads > 0 ? spend / leads : null,
  };
}

// Winner requires BOTH thresholds (min spend AND min leads) plus CPL within
// target — small-sample flukes (1 cheap lead at 6 € spend) stay unclassified.
export function classifyRow(row: NormalizedAdRow, targetCpa: number): ClassifiedAdRow {
  if (row.spend < MIN_SPEND_EUR) {
    return {
      ...row,
      classification: "insufficient_data",
      reason: `Spend ${row.spend.toFixed(2)} € unter Schwelle ${MIN_SPEND_EUR} € — keine Aussage möglich`,
    };
  }
  if (row.leads >= MIN_LEADS && row.cpl !== null && row.cpl <= targetCpa) {
    return {
      ...row,
      classification: "winner",
      reason: `${row.leads} Leads bei CPL ${row.cpl.toFixed(2)} € (Ziel ≤ ${targetCpa} €)`,
    };
  }
  if (row.leads === 0) {
    return {
      ...row,
      classification: "loser",
      reason: `${row.spend.toFixed(2)} € Spend ohne einen einzigen Lead`,
    };
  }
  if (row.cpl !== null && row.cpl > targetCpa) {
    return {
      ...row,
      classification: "loser",
      reason: `CPL ${row.cpl.toFixed(2)} € über Ziel ${targetCpa} €`,
    };
  }
  return {
    ...row,
    classification: "insufficient_data",
    reason: `nur ${row.leads} Lead(s) (< ${MIN_LEADS}) — CPL im Rahmen, aber zu wenig Daten für Winner`,
  };
}

export function classifyRows(rows: MetaInsightRow[], targetCpa: number): ClassifiedAdRow[] {
  return rows.map((r) => classifyRow(normalizeRow(r), targetCpa));
}

function fixturePath(): string {
  return path.join(process.cwd(), "data", "fixtures", "insights-demo.json");
}

export function loadFixtureRows(): MetaInsightRow[] {
  const file = fixturePath();
  if (!fs.existsSync(file)) throw new Error(`Fixture fehlt: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as MetaInsightRow[];
}

function angleName(angleId: string | undefined): string | undefined {
  if (!angleId) return undefined;
  return readCollection("angles").find((a) => a.id === angleId)?.name;
}

// Learnings are deduped on pattern text so repeated optimize runs do not
// flood the feed.
function persistLearnings(
  brandSlug: string,
  rows: ClassifiedAdRow[],
  demo: boolean,
): Learning[] {
  const existing = readCollection("learnings").filter((l) => l.brandSlug === brandSlug);
  const created: Learning[] = [];
  const prefix = demo ? "[Demo-Daten] " : "";
  for (const row of rows) {
    if (row.classification === "insufficient_data") continue;
    const label = angleName(row.angleId) ?? row.adName ?? row.adId;
    const pattern =
      row.classification === "winner"
        ? `${prefix}Winner: „${label}“ — ${row.reason}. Angle-Richtung weiterverfolgen und skalierbar testen.`
        : `${prefix}Loser: „${label}“ — ${row.reason}. Hook/Angle überarbeiten oder verwerfen.`;
    if (existing.some((l) => l.pattern === pattern)) continue;
    const learning: Learning = {
      id: newId("lrn"),
      brandSlug,
      source: "meta_insights",
      pattern,
      evidenceRefs: [row.adId],
    };
    upsert("learnings", learning);
    created.push(learning);
  }
  return created;
}

function buildRecommendation(rows: ClassifiedAdRow[], targetCpa: number): string {
  const winners = rows.filter((r) => r.classification === "winner");
  const losers = rows.filter((r) => r.classification === "loser");
  if (rows.length === 0) {
    return "Noch keine Daten — pausierte frische Ads liefern physikalisch keine Insights. Nächster Schritt: Aktivierung durch einen Menschen im Ads Manager.";
  }
  const parts: string[] = [];
  if (winners.length > 0) {
    const best = winners.reduce((a, b) => ((a.cpl ?? Infinity) <= (b.cpl ?? Infinity) ? a : b));
    parts.push(
      `Empfehlung: Angle hinter „${angleName(best.angleId) ?? best.adName}“ ausbauen (bester CPL ${best.cpl?.toFixed(2)} € bei Ziel ≤ ${targetCpa} €) — 2 neue Hook-Varianten testen.`,
    );
  }
  if (losers.length > 0) {
    parts.push(`${losers.length} Loser pausiert lassen bzw. verwerfen (Mensch entscheidet im Board).`);
  }
  if (parts.length === 0) {
    parts.push("Alle Ads unter den Mindest-Schwellen — weiter Daten sammeln, keine Entscheidung erzwingen.");
  }
  return parts.join(" ");
}

export interface AnalyzeOptions {
  // auto: live read first, fall back to fixture when the account has no data.
  mode?: "auto" | "live" | "fixture";
  // Pre-created by the route so it can answer 202 + runId before the
  // analysis happens (#7); without it the agent creates its own run.
  run?: Run;
}

// The store row can predate the first publish (no campaign_id yet) while the
// seed file already carries the persisted IDs — refresh from seed in that case.
function withMetaIds(brand: Brand): Brand {
  if (brand.meta.campaignId) return brand;
  const seedFile = path.join(process.cwd(), "brands", brand.slug, "brand.json");
  if (!fs.existsSync(seedFile)) return brand;
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf8")) as Brand;
  if (seed.meta.campaignId) {
    brand.meta.campaignId = seed.meta.campaignId;
    brand.meta.adsetId = seed.meta.adsetId;
    upsert("brands", brand);
  }
  return brand;
}

export async function analyzeBrand(
  slug: string,
  options: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const seeded = ensureBrandSeed(slug);
  if (!seeded) throw new Error(`brand_not_found: ${slug}`);
  const brand = withMetaIds(seeded);
  const mode = options.mode ?? "auto";
  const run = options.run ?? startRun(slug, "optimize");

  try {
    let source: "live" | "fixture" = "live";
    let note = "";
    let raw: MetaInsightRow[] = [];

    if (mode !== "fixture") {
      if (!brand.meta.campaignId) {
        note = "keine campaign_id in der Brand — erst publishen, dann liefert der Live-Read Daten";
        logLine(run.id, AGENT, note, "warn");
      } else {
        logLine(run.id, AGENT, `liest echte Insights (campaign_id ${brand.meta.campaignId}) …`);
        raw = await getInsights(brand.meta.campaignId);
        if (raw.length === 0) {
          note =
            "Konnektivität OK, noch keine Daten — pausierte frische Ads liefern physikalisch keine Insights";
          logLine(run.id, AGENT, note);
        } else {
          note = `Live-Insights: ${raw.length} Ad-Zeilen`;
          logLine(run.id, AGENT, note);
        }
      }
    }

    if (mode === "fixture" || (mode === "auto" && raw.length === 0)) {
      raw = loadFixtureRows();
      source = "fixture";
      note = `Demo-Daten (Fixture, ${raw.length} Ads) — kein Live-Ergebnis${
        mode === "auto" ? "; echter Insights-Read lief zuvor erfolgreich gegen das Konto" : ""
      }`;
      logLine(run.id, AGENT, `mined Fixture-Insights (${raw.length} Ads, klar als Demo gelabelt) …`);
    }

    const rows = classifyRows(raw, brand.targetCpa);
    const spend = rows.reduce((s, r) => s + r.spend, 0);
    const leads = rows.reduce((s, r) => s + r.leads, 0);
    const winners = rows.filter((r) => r.classification === "winner").length;
    const losers = rows.filter((r) => r.classification === "loser").length;

    // Fixture learnings go to the store too (that IS the mining demo), but
    // clearly prefixed so they are never mistaken for live findings.
    const learnings = persistLearnings(slug, rows, source === "fixture");
    const recommendation = buildRecommendation(rows, brand.targetCpa);

    if (rows.length > 0) {
      logLine(
        run.id,
        AGENT,
        `Klassifikation: ${winners} Winner, ${losers} Loser, ${rows.length - winners - losers}× zu wenig Daten (Schwellen: ≥ ${MIN_SPEND_EUR} € Spend UND ≥ ${MIN_LEADS} Leads)`,
      );
      logLine(run.id, AGENT, recommendation);
    }
    const result: AnalysisResult = {
      runId: run.id,
      source,
      note,
      totals: { spend, leads, cpl: leads > 0 ? spend / leads : null },
      targetCpa: brand.targetCpa,
      rows,
      learnings,
      recommendation,
    };
    // Async callers (202 + runId, #7) read the result from the run via /state.
    setRunResult(run.id, result);
    endRun(run.id);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(run.id, AGENT, `Fehler: ${message}`, "error");
    endRun(run.id, message);
    throw err;
  }
}
