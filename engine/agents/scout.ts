// Stage 1 — Scout (SPEC §3/§5): URL -> Firecrawl scrape (JSON extraction) +
// optional review search (non-blocking) -> LLM research doc (skill
// research.md) -> brand row + evidence rows (tags hypothesis/external).
// New brands get NO Meta publisher fields — publish stays disabled until a
// human configures account, page and budget (Hard Stops 2/4).

import { completeStructured } from "../connectors/anthropic.ts";
import { scrapeJson, searchWeb } from "../connectors/firecrawl.ts";
import { scoutResearchSchema, type ScoutResearch } from "../schemas.ts";
import { loadSkill } from "../skills.ts";
import {
  appendRunLog,
  createRun,
  finishRun,
  getBrand,
  newId,
  upsert,
} from "../store.ts";
import type { Brand, Evidence, EvidenceTag, Run } from "../types.ts";

const AGENT = "Scout";

export interface OnboardInput {
  url: string;
  name?: string;
  product?: string;
}

// Accepts bare domains ("fitvia.de") as well as full URLs.
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withScheme); // throws on garbage input
  if (!/^https?:$/.test(url.protocol)) throw new Error("invalid_url");
  if (!url.hostname.includes(".")) throw new Error("invalid_url");
  return url.toString();
}

// Multi-part public suffixes where the label before the TLD is still generic.
const SECOND_LEVEL_TLDS = new Set(["co", "com", "net", "org", "gov", "ac", "edu"]);

// Brand slug from the domain: "https://www.holzkern.com/de" -> "holzkern".
export function slugFromUrl(raw: string): string {
  const host = new URL(normalizeUrl(raw)).hostname.toLowerCase().replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  let base = labels[0];
  if (labels.length >= 2) {
    base = labels[labels.length - 2];
    if (labels.length >= 3 && SECOND_LEVEL_TLDS.has(base)) {
      base = labels[labels.length - 3];
    }
  }
  const slug = base
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error("invalid_url");
  return slug;
}

// Firecrawl JSON extraction schema (plain JSON schema, not zod — it is sent
// to the Firecrawl API as-is).
const SCRAPE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    brandName: { type: "string", description: "Name der Marke/Firma" },
    product: { type: "string", description: "Was wird verkauft (Produkt/Service, konkret)" },
    targetAudience: { type: "string", description: "Erkennbare Zielgruppe der Website" },
    valueProposition: { type: "string", description: "Zentrales Nutzenversprechen" },
    pricingModel: { type: "string", description: "Preismodell (Einmalkauf, Abo, Preisspanne)" },
    tonality: { type: "string", description: "Tonalität und Markenstimme der Website-Texte" },
  },
  required: ["brandName", "product", "valueProposition"],
};

interface ScrapeExtraction {
  brandName?: string;
  product?: string;
  targetAudience?: string;
  valueProposition?: string;
  pricingModel?: string;
  tonality?: string;
}

// Minimal brand row for a freshly onboarded brand. No Meta publisher fields:
// publish is disabled until a human configures them (route-level gate).
export function createOnboardBrand(input: OnboardInput): Brand {
  const url = normalizeUrl(input.url);
  const slug = slugFromUrl(url);
  return {
    slug,
    name: input.name?.trim() || slug,
    url,
    product: input.product?.trim() || "wird vom Scout ermittelt …",
    conversionGoal: "website_lead",
    targetCpa: null,
    guardrails: [],
    designTokens: {},
    meta: {
      adAccountId: "",
      pageId: "",
      pixelId: "",
      leadEventName: "Lead",
      geoCountries: ["DE"],
      optimizationGoal: "OFFSITE_CONVERSIONS",
      billingEvent: "IMPRESSIONS",
      specialAdCategories: [],
      fixedDailyBudgetCents: null,
    },
  };
}

function addEvidence(
  brandSlug: string,
  tag: EvidenceTag,
  source: string,
  text: string,
): Evidence {
  const row: Evidence = {
    id: newId("evi"),
    brandSlug,
    tag,
    source,
    text,
    createdBy: "scout",
  };
  upsert("evidence", row);
  return row;
}

function buildResearchPrompt(
  brand: Brand,
  extraction: ScrapeExtraction,
  reviewSnippets: string[],
): string {
  const parts: string[] = [];
  parts.push(`# Onboarding: ${brand.name} (${brand.url})`);
  parts.push(
    "## Website-Extraktion (Firecrawl, strukturiert)\n" +
      JSON.stringify(extraction, null, 2),
  );
  if (reviewSnippets.length > 0) {
    parts.push(
      "## Fundstücke aus der Review-Suche (Web, ungefiltert)\n" +
        reviewSnippets.map((s, i) => `### Quelle ${i + 1}\n${s}`).join("\n\n"),
    );
  } else {
    parts.push(
      "## Review-Suche\nKeine externen Fundstücke verfügbar — arbeite nur mit " +
        "der Website-Extraktion und kennzeichne entsprechend mehr als Hypothese.",
    );
  }
  parts.push(
    "## Auftrag\nErstelle das Unified Research Document nach dem Skill und dem " +
      "vorgegebenen Schema: 2-4 Segmente mit Psychographie und Schmerzen, " +
      "geschätzte Awareness-Verteilung in Prozent (Summe ~100, explizit eine " +
      "Hypothese ohne Datenbasis), Competitor-Hinweise, wörtliche VoC-Sprache " +
      "(nur aus den Fundstücken zitieren, nichts erfinden) und Einwände. Deutsch. " +
      "WICHTIG: kompakt schreiben — 1-3 Sätze pro Feld, keine Absätze, " +
      "Gesamtdokument unter 500 Wörter. Das Doc ist Arbeitsgrundlage für den " +
      "Strategist, kein Bericht.",
  );
  return parts.join("\n\n");
}

// Non-blocking review search (SPEC §5: the scout path never dies on
// Firecrawl) — failures are logged and tolerated.
async function collectReviewSnippets(
  brandName: string,
  runId: string,
): Promise<string[]> {
  try {
    const result = await searchWeb(`${brandName} Bewertungen Erfahrungen`, 4);
    const docs = (result as { web?: { markdown?: string; url?: string }[] }).web ?? [];
    const snippets = docs
      .map((d) => {
        const body = (d.markdown ?? "").trim();
        if (!body) return null;
        return `${d.url ?? "unbekannte Quelle"}\n${body.slice(0, 2500)}`;
      })
      .filter((s): s is string => s !== null)
      .slice(0, 4);
    appendRunLog(
      runId,
      AGENT,
      `Review-Suche: ${snippets.length} verwertbare Fundstücke`,
    );
    return snippets;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(
      runId,
      AGENT,
      `Review-Suche fehlgeschlagen (${message}) — weiter ohne externe Quellen`,
      "warn",
    );
    return [];
  }
}

function persistEvidence(
  brand: Brand,
  research: ScoutResearch,
  hasExternalSources: boolean,
  runId: string,
): number {
  let count = 0;
  const site = brand.url;

  addEvidence(
    brand.slug,
    "external",
    site,
    `Produkt laut Website: ${research.productSummary}`,
  );
  addEvidence(
    brand.slug,
    "external",
    site,
    `Nutzenversprechen: ${research.valueProposition} · Preismodell: ${research.pricingModel} · Tonalität: ${research.tonality}`,
  );
  count += 2;

  for (const seg of research.segments) {
    addEvidence(
      brand.slug,
      "hypothesis",
      "scout:research",
      `Segment „${seg.name}“: ${seg.psychographics} · Schmerzen: ${seg.pains.join("; ")}`,
    );
    count += 1;
  }

  const d = research.awarenessDistribution;
  addEvidence(
    brand.slug,
    "hypothesis",
    "scout:research",
    `HYPOTHESE Awareness-Verteilung (geschätzt, keine Datenbasis): unaware ${d.unaware} % · problem-aware ${d.problemAware} % · solution-aware ${d.solutionAware} % · product-aware ${d.productAware} % · most-aware ${d.mostAware} %. Begründung: ${research.awarenessRationale}`,
  );
  count += 1;

  for (const note of research.competitorNotes) {
    addEvidence(brand.slug, "hypothesis", "scout:research", `Competitor-Hinweis: ${note}`);
    count += 1;
  }
  for (const phrase of research.vocPhrases) {
    addEvidence(
      brand.slug,
      hasExternalSources ? "external" : "hypothesis",
      hasExternalSources ? "scout:web-search" : "scout:research",
      `VoC-Sprache: ${phrase}`,
    );
    count += 1;
  }
  for (const objection of research.objections) {
    addEvidence(brand.slug, "hypothesis", "scout:research", `Einwand: ${objection}`);
    count += 1;
  }
  appendRunLog(runId, AGENT, `${count} Evidence-Einträge gespeichert (hypothesis/external)`);
  return count;
}

// opts.run: pre-created by the route so it can answer 202 + runId before the
// scrape/LLM work happens (#7); without it the agent creates its own run.
export async function runScout(
  input: OnboardInput,
  opts: { run?: Run } = {},
): Promise<{ runId: string; brand: Brand; research: ScoutResearch }> {
  const url = normalizeUrl(input.url);
  const slug = slugFromUrl(url);
  // The route usually creates the stub brand synchronously so /state works
  // right after the 202; this is the fallback for direct agent calls.
  let brand = getBrand(slug) ?? createOnboardBrand(input);
  upsert("brands", brand);

  const run = opts.run ?? createRun(slug, "scout");
  try {
    appendRunLog(run.id, AGENT, `liest ${url} (Firecrawl-Extraktion) …`);
    const extraction = ((await scrapeJson(
      url,
      SCRAPE_SCHEMA,
      "Extrahiere Marke, Produkt, Zielgruppe, Nutzenversprechen, Preismodell und Tonalität dieser Website.",
    )) ?? {}) as ScrapeExtraction;
    appendRunLog(
      run.id,
      AGENT,
      `Website erfasst: ${extraction.product?.slice(0, 120) ?? "keine Produkt-Extraktion"}`,
    );

    const brandName = input.name?.trim() || extraction.brandName?.trim() || slug;
    appendRunLog(run.id, AGENT, `sucht Bewertungen und Erfahrungen zu „${brandName}“ …`);
    const reviewSnippets = await collectReviewSnippets(brandName, run.id);

    appendRunLog(run.id, AGENT, "destilliert das Unified Research Document …");
    const research = await completeStructured({
      role: "scout",
      system: loadSkill("research"),
      prompt: buildResearchPrompt({ ...brand, name: brandName }, extraction, reviewSnippets),
      schema: scoutResearchSchema,
      schemaName: "scout_research",
      // German prose is token-hungry; a truncated doc must never kill the
      // onboarding stunt (<90 s, SPEC §3 Stufe 1).
      maxTokens: 16384,
    });

    brand = {
      ...brand,
      name: brandName,
      product: input.product?.trim() || extraction.product?.trim() || research.productSummary,
    };
    upsert("brands", brand);
    appendRunLog(run.id, AGENT, `Brand „${brand.name}“ (${brand.slug}) im Store aktualisiert`);

    persistEvidence(brand, research, reviewSnippets.length > 0, run.id);
    appendRunLog(
      run.id,
      AGENT,
      "fertig: Research-Doc steht — Publish bleibt deaktiviert, bis Meta-Konfiguration und Budget menschlich gesetzt sind",
    );
    finishRun(run.id);
    return { runId: run.id, brand, research };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(run.id, AGENT, `Fehler: ${message}`, "error");
    finishRun(run.id, message);
    throw err;
  }
}
