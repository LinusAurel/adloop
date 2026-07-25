// Firecrawl connector (SPEC §5): scrape + search for the Scout stage.
// Non-blocking path — the loyft demo slice never depends on Firecrawl.
// Ohne FIRECRAWL_API_KEY läuft der Connector im deterministischen MOCK-Modus
// (analog zum Anthropic-Connector, #19): Scrape und Suche liefern klar als
// MOCK markierte Beispieldaten, damit Tests und Demos ohne Key laufen.

import Firecrawl from "@mendable/firecrawl-js";

const SEARCH_ENDPOINT = "https://api.firecrawl.dev/v2/search";

export function isFirecrawlMockMode(): boolean {
  return !process.env.FIRECRAWL_API_KEY;
}

// Der cwd steht im Hinweis, weil ein Dev-Server aus einem Worktree keine .env
// hat (gitignored) und sonst still im Mock-Modus landet.
export function firecrawlMockHint(): string {
  return (
    "MOCK mode active: FIRECRAWL_API_KEY missing in server process " +
    `(cwd: ${process.cwd()}) — scrape and search results are sample data. ` +
    "The .env lives only in the main checkout; create a copy when running from a worktree."
  );
}

function client(): Firecrawl {
  return new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
}

// Deterministischer Mock für eine JSON-Extraktion: füllt jedes Top-Level-Feld
// des Schemas mit einem klar markierten Beispielwert.
function mockExtraction(schema: Record<string, unknown>): Record<string, unknown> {
  const properties =
    (schema.properties as Record<string, { type?: string; description?: string }>) ?? {};
  const result: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(properties)) {
    const label = `MOCK: ${prop.description ?? name}`;
    if (prop.type === "array") result[name] = [label];
    else if (prop.type === "number" || prop.type === "integer") result[name] = 1;
    else if (prop.type === "boolean") result[name] = false;
    else result[name] = label;
  }
  return result;
}

// Structured scrape: returns the JSON extraction for the given schema.
export async function scrapeJson(
  url: string,
  schema: Record<string, unknown>,
  prompt?: string,
): Promise<unknown> {
  if (isFirecrawlMockMode()) {
    console.log(`[MOCK] firecrawl scrape ${url}: ${firecrawlMockHint()}`);
    return mockExtraction(schema);
  }
  const doc = await client().scrape(url, {
    formats: [{ type: "json", schema, prompt }],
  });
  return doc.json;
}

export interface SearchHit {
  url: string;
  title: string;
  description: string;
  position: number;
}

// Deterministische Mock-Treffer: aus der Query abgeleitet, damit Tests
// stabile, wiedererkennbare Ergebnisse bekommen.
function mockSearchHits(query: string, limit: number): SearchHit[] {
  const slug =
    query
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/g, "-")
      .replace(/^-+|-+$/g, "") || "query";
  const hosts = [
    "bewertungen.example",
    "forum.example",
    "vergleich.example",
    "magazin.example",
    "blog.example",
  ];
  return hosts.slice(0, Math.max(1, Math.min(limit, hosts.length))).map((host, i) => ({
    url: `https://${host}/${slug}`,
    title: `MOCK result ${i + 1} for ${query}`,
    description: `MOCK: deterministic sample search result for ${query} (no API key)`,
    position: i + 1,
  }));
}

// Web search via POST /v2/search: returns title/description/position per hit
// (no scraped page content — external pages are scraped separately on demand).
export async function firecrawlSearch(query: string, limit = 5): Promise<SearchHit[]> {
  if (isFirecrawlMockMode()) {
    console.log(`[MOCK] firecrawl search "${query}": ${firecrawlMockHint()}`);
    return mockSearchHits(query, limit);
  }

  const res = await fetch(SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) {
    throw new Error(`Firecrawl search failed (HTTP ${res.status})`);
  }
  const payload = (await res.json()) as {
    success?: boolean;
    data?: {
      web?: { url?: string; title?: string; description?: string; position?: number }[];
    };
  };
  if (!payload.success) {
    throw new Error("Firecrawl search failed (success=false)");
  }
  return (payload.data?.web ?? [])
    .filter(
      (hit): hit is { url: string; title?: string; description?: string; position?: number } =>
        typeof hit.url === "string" && hit.url.length > 0,
    )
    .slice(0, limit)
    .map((hit, i) => ({
      url: hit.url,
      title: hit.title ?? "",
      description: hit.description ?? "",
      position: hit.position ?? i + 1,
    }));
}

// Web search with scraped content, e.g. "<brand> bewertungen trustpilot".
// Kept for callers that want full markdown per hit in a single call.
export async function searchWeb(query: string, limit = 5) {
  if (isFirecrawlMockMode()) {
    console.log(`[MOCK] firecrawl searchWeb "${query}": ${firecrawlMockHint()}`);
    return {
      web: mockSearchHits(query, limit).map((hit) => ({
        url: hit.url,
        title: hit.title,
        markdown: `${hit.description}\n\nMOCK: sample text of an external source for ${query}.`,
      })),
    };
  }
  return client().search(query, {
    limit,
    scrapeOptions: { formats: ["markdown"] },
  });
}
