// Firecrawl connector (SPEC §5): scrape + search for the Scout stage.
// Non-blocking path — the loyft demo slice never depends on Firecrawl.

import Firecrawl from "@mendable/firecrawl-js";

function client(): Firecrawl {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY fehlt (.env)");
  return new Firecrawl({ apiKey });
}

// Structured scrape: returns the JSON extraction for the given schema.
export async function scrapeJson(
  url: string,
  schema: Record<string, unknown>,
  prompt?: string,
): Promise<unknown> {
  const doc = await client().scrape(url, {
    formats: [{ type: "json", schema, prompt }],
  });
  return doc.json;
}

// Web search with scraped content, e.g. "<brand> bewertungen trustpilot".
export async function searchWeb(query: string, limit = 5) {
  return client().search(query, {
    limit,
    scrapeOptions: { formats: ["markdown"] },
  });
}
