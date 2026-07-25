// Mock-Pfad der Scout-Web-Recherche (#19): ohne API-Keys liefern Suche und
// Scrape deterministische Beispieldaten, und ein kompletter Scout-Lauf endet
// erfolgreich — inklusive Fortschritts-Logs und Außensicht-Evidence.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Wichtig: die Connectoren lesen die Keys erst zur Laufzeit — Mock-Modus und
// isolierter Datenordner lassen sich daher hier im Testprozess erzwingen.
delete process.env.FIRECRAWL_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
process.env.ADLOOP_DATA_DIR = mkdtempSync(path.join(tmpdir(), "adloop-scout-research-"));

import { buildResearchQueries, runScout } from "../engine/agents/scout.ts";
import { firecrawlSearch, isFirecrawlMockMode } from "../engine/connectors/firecrawl.ts";
import { readCollection } from "../engine/store.ts";

test("firecrawlSearch ohne Key: deterministischer Mock", async () => {
  assert.equal(isFirecrawlMockMode(), true);
  const first = await firecrawlSearch("loyft Erfahrungen", 3);
  const second = await firecrawlSearch("loyft Erfahrungen", 3);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  for (const [i, hit] of first.entries()) {
    assert.match(hit.url, /^https:\/\/[a-z]+\.example\//);
    assert.ok(hit.title.includes("MOCK"));
    assert.equal(hit.position, i + 1);
  }
});

test("firecrawlSearch respektiert das Limit", async () => {
  const hits = await firecrawlSearch("irgendeine Marke Bewertung", 2);
  assert.equal(hits.length, 2);
});

test("buildResearchQueries: 3 Queries ohne, 4 mit Kategorie — hartes Limit 4", () => {
  const withoutCategory = buildResearchQueries("loyft");
  assert.deepEqual(withoutCategory, [
    "loyft Erfahrungen",
    "loyft Bewertung",
    "loyft Alternative",
  ]);
  const withCategory = buildResearchQueries("loyft", "Ökostrom-Wechselservice");
  assert.equal(withCategory.length, 4);
  assert.equal(withCategory[3], "Ökostrom-Wechselservice Anbieter Vergleich");
  // Leere/Whitespace-Kategorie erzeugt keine vierte Suche.
  assert.equal(buildResearchQueries("loyft", "   ").length, 3);
});

test("Scout-Lauf im Mock-Modus endet erfolgreich und loggt die Recherche", async () => {
  const { runId, brand, research } = await runScout({ url: "https://scoutmock.example" });

  const run = readCollection("runs").find((r) => r.id === runId);
  assert.ok(run, "Run muss im Store liegen");
  assert.equal(run.status, "finished");
  assert.equal(run.error, undefined);

  // Fortschritt der Research-Phase ist über appendRunLog sichtbar (Ticker).
  const messages = run.log.map((entry) => entry.message);
  assert.ok(
    messages.some((m) => /^Suche 1\/\d:/.test(m)),
    `Suchfortschritt fehlt im Run-Log: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    messages.some((m) => m.startsWith("liest Fundstelle 1/")),
    "Scrape-Fortschritt fehlt im Run-Log",
  );

  // Research-Doc enthält die Außensicht-Sektionen (Mock-Daten, optional im Schema).
  assert.ok(research.productSummary.length > 0);
  assert.ok((research.competitorProfiles ?? []).length > 0);
  assert.ok((research.externalObjections ?? []).length > 0);
  assert.ok(research.marketContext);

  // Außensicht landet als Evidence im Store, bestehende Sektionen bleiben.
  const evidence = readCollection("evidence").filter((e) => e.brandSlug === brand.slug);
  assert.ok(evidence.length > 0);
  assert.ok(evidence.some((e) => e.text.startsWith("Wettbewerber")));
  assert.ok(evidence.some((e) => e.text.startsWith("Einwand (Außensicht):")));
  assert.ok(evidence.some((e) => e.text.startsWith("Markt-Kontext:")));
  assert.ok(evidence.some((e) => e.text.startsWith("VoC-Sprache:")));
});
