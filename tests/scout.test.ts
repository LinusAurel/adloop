import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createOnboardBrand,
  normalizeUrl,
  slugFromUrl,
} from "../engine/agents/scout.ts";
import { scoutResearchSchema, type ScoutResearch } from "../engine/schemas.ts";

test("slugFromUrl leitet den Slug aus der Domain ab", () => {
  assert.equal(slugFromUrl("https://fitvia.de"), "fitvia");
  assert.equal(slugFromUrl("https://www.holzkern.com/de/ueber-uns"), "holzkern");
  assert.equal(slugFromUrl("http://shop.example.co.uk"), "example");
  assert.equal(slugFromUrl("loyft.de"), "loyft");
});

test("slugFromUrl normalisiert auf lowercase-kebab", () => {
  assert.equal(slugFromUrl("https://MeineMarke.DE"), "meinemarke");
});

test("slugFromUrl wirft bei Müll-Eingaben", () => {
  assert.throws(() => slugFromUrl("kein url"));
  assert.throws(() => slugFromUrl("localhost"));
});

test("normalizeUrl ergänzt https und lehnt Nicht-HTTP-Schemata ab", () => {
  assert.equal(normalizeUrl("fitvia.de"), "https://fitvia.de/");
  assert.equal(normalizeUrl("https://holzkern.com/de"), "https://holzkern.com/de");
  assert.throws(() => normalizeUrl("ftp://beispiel.de"));
});

test("createOnboardBrand: website_lead, targetCpa null, keine Meta-Publisher-Felder", () => {
  const brand = createOnboardBrand({ url: "https://fitvia.de" });
  assert.equal(brand.slug, "fitvia");
  assert.equal(brand.conversionGoal, "website_lead");
  assert.equal(brand.targetCpa, null);
  assert.equal(brand.meta.adAccountId, "");
  assert.equal(brand.meta.pageId, "");
  assert.equal(brand.meta.fixedDailyBudgetCents, null);
  assert.equal(brand.meta.campaignId, undefined);
});

function makeResearch(overrides: Partial<ScoutResearch> = {}): ScoutResearch {
  return {
    productSummary:
      "Tee-Blends im Direktvertrieb, positioniert als Alltagsritual für Frauen zwischen 25 und 45.",
    valueProposition: "Wohlbefinden als tägliches Ritual statt Diät-Versprechen",
    pricingModel: "Einmalkauf und Spar-Bundles, mittleres Preissegment",
    tonality: "nahbar, feminin, leicht premium",
    segments: [
      {
        name: "Ritual-Sucherinnen",
        psychographics:
          "Wollen kleine Alltags-Anker statt großer Umstellungen; skeptisch gegenüber Diät-Marketing.",
        pains: ["Hat Diät-Produkte probiert und wurde enttäuscht"],
      },
      {
        name: "Geschenke-Käuferinnen",
        psychographics:
          "Suchen hübsch verpackte, unverfängliche Geschenke mit Selbstfürsorge-Botschaft.",
        pains: ["Standard-Geschenke wirken einfallslos"],
      },
    ],
    awarenessDistribution: {
      unaware: 35,
      problemAware: 30,
      solutionAware: 20,
      productAware: 10,
      mostAware: 5,
    },
    awarenessRationale:
      "Hypothese ohne Datenbasis: Kategorie ist bekannt, die Marke nur Instagram-affinen Käuferinnen.",
    competitorNotes: ["Wettbewerber verkaufen über Rabatt-Codes und Influencer-Bundles"],
    vocPhrases: ["„endlich ein Tee, der nicht nach Heu schmeckt“"],
    objections: ["Wirkt teuer im Vergleich zum Supermarkt-Tee"],
    ...overrides,
  };
}

test("scoutResearchSchema akzeptiert ein valides Research-Doc", () => {
  const parsed = scoutResearchSchema.parse(makeResearch());
  assert.equal(parsed.segments.length, 2);
});

test("scoutResearchSchema verlangt mindestens 2 Segmente", () => {
  const doc = makeResearch();
  assert.throws(() =>
    scoutResearchSchema.parse({ ...doc, segments: [doc.segments[0]] }),
  );
});

test("scoutResearchSchema begrenzt die Awareness-Anteile auf 0-100", () => {
  const doc = makeResearch();
  assert.throws(() =>
    scoutResearchSchema.parse({
      ...doc,
      awarenessDistribution: { ...doc.awarenessDistribution, unaware: 140 },
    }),
  );
});

test("scoutResearchSchema lehnt fehlende Pflichtfelder ab", () => {
  const doc: Record<string, unknown> = { ...makeResearch() };
  delete doc.awarenessRationale;
  assert.throws(() => scoutResearchSchema.parse(doc));
});
