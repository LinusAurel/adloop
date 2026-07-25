// Stage 1 — Scout (SPEC §3/§5): URL -> Firecrawl scrape (JSON extraction) ->
// Web-Recherche (#19: gezielte Suchen + Scrapes fremder Fundstellen,
// non-blocking) -> LLM research doc (skill research.md) -> brand row +
// evidence rows (tags hypothesis/external).
// New brands get NO Meta publisher fields — publish stays disabled until a
// human configures account, page and budget (Hard Stops 2/4).

import { completeStructured, isMockMode, mockModeHint } from "../connectors/anthropic.ts";
import { firecrawlSearch, scrapeJson, type SearchHit } from "../connectors/firecrawl.ts";
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

// Hartes Budget pro Onboarding (#19): Web-Recherche darf Latenz kosten (der
// Scout läuft als async Job hinter 202+runId), aber nie unbegrenzt.
const MAX_SEARCHES = 4;
const MAX_EXTRA_SCRAPES = 3;
const RESULTS_PER_SEARCH = 5;

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
    category: {
      type: "string",
      description: "Produkt-/Marktkategorie in 2-4 Worten (z. B. Ökostrom-Wechselservice)",
    },
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
  category?: string;
  targetAudience?: string;
  valueProposition?: string;
  pricingModel?: string;
  tonality?: string;
}

// Extraktion pro externer Fundstelle (#19): kompakt genug für den Prompt,
// wörtliche Zitate bleiben erhalten (VoC-Rohstoff, nicht glätten).
const EXTERNAL_SOURCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Kernaussage der Seite zur Marke bzw. Kategorie in 2-3 Sätzen",
    },
    customerQuotes: {
      type: "array",
      items: { type: "string" },
      description: "Wörtliche Kundenzitate (Reviews, Foren) in Originalsprache, nicht glätten",
    },
    complaints: {
      type: "array",
      items: { type: "string" },
      description: "Kritikpunkte, Einwände und negative Erfahrungen",
    },
    competitorsMentioned: {
      type: "array",
      items: { type: "string" },
      description: "Genannte Wettbewerber/Alternativen inklusive deren Positionierung",
    },
  },
  required: ["summary"],
};

interface ExternalExtraction {
  summary?: string;
  customerQuotes?: string[];
  complaints?: string[];
  competitorsMentioned?: string[];
}

interface ExternalSource {
  url: string;
  extraction: ExternalExtraction;
}

export interface WebResearch {
  hits: SearchHit[];
  sources: ExternalSource[];
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

// Gezielte Suchanfragen aus Brand-Name und (falls extrahiert) Kategorie —
// hart auf MAX_SEARCHES begrenzt. Exportiert für Tests.
export function buildResearchQueries(brandName: string, category?: string): string[] {
  const queries = [
    `${brandName} Erfahrungen`,
    `${brandName} Bewertung`,
    `${brandName} Alternative`,
  ];
  const cat = category?.trim();
  if (cat) queries.push(`${cat} Anbieter Vergleich`);
  return queries.slice(0, MAX_SEARCHES);
}

// Eigene Domain (inkl. Subdomains) aus den Treffern filtern — die Außensicht
// soll aus fremden Quellen kommen, nicht von der Brand-Website selbst.
function isOwnDomain(hitUrl: string, brandHost: string): boolean {
  try {
    const host = new URL(hitUrl).hostname.toLowerCase().replace(/^www\./, "");
    return host === brandHost || host.endsWith(`.${brandHost}`);
  } catch {
    return true; // kaputte URLs gar nicht erst scrapen
  }
}

// Research-Phase (#19): max. MAX_SEARCHES Suchen, danach die relevantesten
// fremden Treffer (round-robin über die Queries, beste Position zuerst)
// zusätzlich scrapen — max. MAX_EXTRA_SCRAPES. Fehler je Suche/Treffer werden
// toleriert und geloggt; die Phase liefert schlimmstenfalls leere Listen.
async function runWebResearch(
  brandName: string,
  category: string | undefined,
  brandUrl: string,
  runId: string,
): Promise<WebResearch> {
  const queries = buildResearchQueries(brandName, category);
  const brandHost = new URL(brandUrl).hostname.toLowerCase().replace(/^www\./, "");

  const perQuery: SearchHit[][] = [];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];

  for (const [i, query] of queries.entries()) {
    appendRunLog(runId, AGENT, `Search ${i + 1}/${queries.length}: ${query} …`);
    try {
      const results = await firecrawlSearch(query, RESULTS_PER_SEARCH);
      const fresh = results.filter((hit) => {
        if (seen.has(hit.url)) return false;
        seen.add(hit.url);
        return true;
      });
      hits.push(...fresh);
      perQuery.push(fresh.filter((hit) => !isOwnDomain(hit.url, brandHost)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendRunLog(
        runId,
        AGENT,
        `Search "${query}" failed (${message}) — continuing with the rest`,
        "warn",
      );
      perQuery.push([]);
    }
  }

  // Round-robin über die Queries: erst die Top-Treffer jeder Suche, dann die
  // zweiten usw., bis das Scrape-Budget erreicht ist.
  const targets: SearchHit[] = [];
  for (let rank = 0; targets.length < MAX_EXTRA_SCRAPES; rank += 1) {
    let any = false;
    for (const list of perQuery) {
      const hit = list[rank];
      if (!hit) continue;
      any = true;
      if (targets.length < MAX_EXTRA_SCRAPES && !targets.some((t) => t.url === hit.url)) {
        targets.push(hit);
      }
    }
    if (!any) break;
  }

  appendRunLog(
    runId,
    AGENT,
    `Web research: ${hits.length} results, reading ${targets.length} external sources`,
  );

  const sources: ExternalSource[] = [];
  for (const [i, target] of targets.entries()) {
    let host = target.url;
    try {
      host = new URL(target.url).hostname;
    } catch {
      // URL kam aus der Suche; im Zweifel die Roh-URL loggen.
    }
    appendRunLog(runId, AGENT, `Reading source ${i + 1}/${targets.length}: ${host} …`);
    try {
      const extraction = ((await scrapeJson(
        target.url,
        EXTERNAL_SOURCE_SCHEMA,
        `Extrahiere, was diese Seite über „${brandName}“ bzw. die Produktkategorie sagt: Kernaussage, wörtliche Kundenzitate, Kritikpunkte, genannte Wettbewerber.`,
      )) ?? {}) as ExternalExtraction;
      sources.push({ url: target.url, extraction });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendRunLog(
        runId,
        AGENT,
        `Source ${host} not readable (${message}) — skipped`,
        "warn",
      );
    }
  }

  return { hits, sources };
}

function buildResearchPrompt(
  brand: Brand,
  extraction: ScrapeExtraction,
  research: WebResearch,
): string {
  const parts: string[] = [];
  parts.push(`# Onboarding: ${brand.name} (${brand.url})`);
  parts.push(
    "## Website-Extraktion (Firecrawl, strukturiert)\n" +
      JSON.stringify(extraction, null, 2),
  );

  if (research.hits.length > 0) {
    parts.push(
      "## Suchtreffer aus der Web-Recherche (Titel und Beschreibung)\n" +
        research.hits
          .slice(0, 12)
          .map((hit) => `- ${hit.title} — ${hit.description} (${hit.url})`)
          .join("\n"),
    );
  }
  if (research.sources.length > 0) {
    parts.push(
      "## Externe Fundstellen (gescrapt, fremde Domains)\n" +
        research.sources
          .map(
            (source, i) =>
              `### Quelle ${i + 1}: ${source.url}\n` +
              JSON.stringify(source.extraction, null, 2),
          )
          .join("\n\n"),
    );
  }
  if (research.hits.length === 0 && research.sources.length === 0) {
    parts.push(
      "## Web-Recherche\nKeine externen Fundstücke verfügbar — arbeite nur mit " +
        "der Website-Extraktion und kennzeichne entsprechend mehr als Hypothese.",
    );
  }

  parts.push(
    "## Auftrag\nErstelle das Unified Research Document nach dem Skill und dem " +
      "vorgegebenen Schema: 2-4 Segmente mit Psychographie und Schmerzen, " +
      "geschätzte Awareness-Verteilung in Prozent (Summe ~100, explizit eine " +
      "Hypothese ohne Datenbasis), Competitor-Hinweise, wörtliche VoC-Sprache " +
      "(nur aus den Fundstücken zitieren, nichts erfinden) und Einwände. " +
      "Fülle zusätzlich die Außensicht-Sektionen, sofern die Recherche Material " +
      "liefert (sonst weglassen): competitorProfiles (Wettbewerber und deren " +
      "Positionierung, nüchtern), externalObjections (Einwände aus der " +
      "Außensicht: was Reviews und Foren kritisch sehen), marketContext " +
      "(Markt-Kontext und Sophistication in 2-3 Sätzen). Voice of Customer " +
      "heißt: wörtliche Kundenformulierungen aus den externen Fundstellen " +
      "übernehmen, Originalsprache erhalten. Deutsch. " +
      "WICHTIG: kompakt schreiben — 1-3 Sätze pro Feld, keine Absätze, " +
      "Gesamtdokument unter 600 Wörter. Das Doc ist Arbeitsgrundlage für den " +
      "Strategist, kein Bericht.",
  );
  return parts.join("\n\n");
}

function persistEvidence(
  brand: Brand,
  research: ScoutResearch,
  hasExternalSources: boolean,
  runId: string,
): number {
  let count = 0;
  const site = brand.url;
  const externalTag: EvidenceTag = hasExternalSources ? "external" : "hypothesis";
  const externalSource = hasExternalSources ? "scout:web-search" : "scout:research";

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
    addEvidence(brand.slug, externalTag, externalSource, `VoC-Sprache: ${phrase}`);
    count += 1;
  }
  for (const objection of research.objections) {
    addEvidence(brand.slug, "hypothesis", "scout:research", `Einwand: ${objection}`);
    count += 1;
  }

  // Außensicht-Sektionen (#19) — optional im Schema; getaggt als external,
  // sobald fremde Quellen im Spiel waren.
  for (const comp of research.competitorProfiles ?? []) {
    addEvidence(
      brand.slug,
      externalTag,
      externalSource,
      `Wettbewerber „${comp.name}“: ${comp.positioning}`,
    );
    count += 1;
  }
  for (const objection of research.externalObjections ?? []) {
    addEvidence(brand.slug, externalTag, externalSource, `Einwand (Außensicht): ${objection}`);
    count += 1;
  }
  if (research.marketContext) {
    addEvidence(brand.slug, externalTag, externalSource, `Markt-Kontext: ${research.marketContext}`);
    count += 1;
  }

  appendRunLog(runId, AGENT, `Stored ${count} evidence entries (hypothesis/external)`);
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
    // A mock run must be recognizable as such in the UI, not only on stdout (#12).
    if (isMockMode()) appendRunLog(run.id, AGENT, mockModeHint(), "warn");
    appendRunLog(run.id, AGENT, `Reading ${url} (Firecrawl extraction) …`);
    const extraction = ((await scrapeJson(
      url,
      SCRAPE_SCHEMA,
      "Extrahiere Marke, Produkt, Kategorie, Zielgruppe, Nutzenversprechen, Preismodell und Tonalität dieser Website.",
    )) ?? {}) as ScrapeExtraction;
    appendRunLog(
      run.id,
      AGENT,
      `Website captured: ${extraction.product?.slice(0, 120) ?? "no product extraction"}`,
    );

    const brandName = input.name?.trim() || extraction.brandName?.trim() || slug;
    // Deep Research (#19): non-blocking — Fehler je Suche/Fundstelle werden
    // innerhalb von runWebResearch toleriert, der Scout-Pfad stirbt nie daran.
    appendRunLog(run.id, AGENT, `Starting web research on "${brandName}" …`);
    const webResearch = await runWebResearch(brandName, extraction.category, url, run.id);
    const hasExternalSources = webResearch.sources.length > 0;

    appendRunLog(run.id, AGENT, "Distilling the unified research document …");
    const research = await completeStructured({
      role: "scout",
      system: loadSkill("research"),
      prompt: buildResearchPrompt({ ...brand, name: brandName }, extraction, webResearch),
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
    appendRunLog(run.id, AGENT, `Brand "${brand.name}" (${brand.slug}) updated in store`);

    persistEvidence(brand, research, hasExternalSources, run.id);
    appendRunLog(
      run.id,
      AGENT,
      "Done: research doc ready — publishing stays disabled until Meta configuration and budget are set by a human",
    );
    finishRun(run.id);
    return { runId: run.id, brand, research };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(run.id, AGENT, `Error: ${message}`, "error");
    finishRun(run.id, message);
    throw err;
  }
}
