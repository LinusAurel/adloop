// Firecrawl connector (SPEC §5): scrape + search for the Scout stage.
// Non-blocking path — the loyft demo slice never depends on Firecrawl.

import Firecrawl from "@mendable/firecrawl-js";

// The key is read at call time (never at module load) so a late-loaded env
// still works; the error names the server cwd because a dev server started
// from a worktree has no .env (gitignored) and silently misses every key.
function client(): Firecrawl {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error(
      `FIRECRAWL_API_KEY fehlt im Server-Prozess (cwd: ${process.cwd()}). ` +
        "Die .env liegt nur im Haupt-Checkout — läuft der Server aus einem " +
        "Worktree, dort eine .env-Kopie anlegen und den Server neu starten.",
    );
  }
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
