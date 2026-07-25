import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { applyBrandPatch } from "../engine/brand-edit.ts";
import { brandPatchSchema } from "../engine/schemas.ts";
import { readCollection, upsert } from "../engine/store.ts";
import type { Brand } from "../engine/types.ts";

let dir: string;

const baseBrand: Brand = {
  slug: "patch-test",
  name: "Patch Test",
  url: "https://example.com",
  product: "Testprodukt für die Brand-Editing-API",
  conversionGoal: "website_lead",
  targetCpa: 30,
  guardrails: ["Keine garantierten Ergebnisse versprechen"],
  designTokens: { primary: "#111111" },
  meta: {
    adAccountId: "demo-act-9",
    pageId: "demo-page-9",
    pixelId: "",
    leadEventName: "Lead",
    geoCountries: ["DE"],
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    specialAdCategories: [],
    fixedDailyBudgetCents: null,
    campaignId: "demo-camp-9",
  },
};

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "adloop-brand-edit-test-"));
  process.env.ADLOOP_DATA_DIR = dir;
  upsert("brands", baseBrand);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADLOOP_DATA_DIR;
});

test("Schema: gültiger Teil-Patch passiert die Validierung", () => {
  const parsed = brandPatchSchema.safeParse({
    name: "Neuer Name",
    targetCpa: 45,
    cta: { label: "Jetzt anfragen" },
    meta: { campaignTarget: { metric: "CPL", value: 40 } },
  });
  assert.equal(parsed.success, true);
});

test("Schema: unbekannte Felder werden abgelehnt (strict)", () => {
  for (const bad of [
    { slug: "neuer-slug" },
    { conversionGoal: "purchase" },
    { meta: { campaignId: "hijack" } },
    { totallyUnknown: 1 },
  ]) {
    const parsed = brandPatchSchema.safeParse(bad);
    assert.equal(parsed.success, false, `sollte abgelehnt werden: ${JSON.stringify(bad)}`);
  }
});

test("Schema: falsche Typen und Wertebereiche werden abgelehnt", () => {
  for (const bad of [
    { url: "keine-url" },
    { targetCpa: -5 },
    { meta: { campaignTarget: { metric: "ROAS", value: 3 } } },
    { meta: { fixedDailyBudgetCents: 10.5 } },
    { cta: { label: "" } },
  ]) {
    const parsed = brandPatchSchema.safeParse(bad);
    assert.equal(parsed.success, false, `sollte abgelehnt werden: ${JSON.stringify(bad)}`);
  }
});

test("applyBrandPatch: Top-Level-Felder werden gemerged, Rest bleibt", () => {
  const next = applyBrandPatch("patch-test", {
    name: "Patch Test 2",
    guardrails: ["Neue Regel mit genug Länge"],
    cta: { label: "Jetzt Termin sichern", subline: "Dauert nur zwei Minuten." },
  });
  assert.equal(next.name, "Patch Test 2");
  assert.equal(next.url, "https://example.com");
  assert.deepEqual(next.cta, {
    label: "Jetzt Termin sichern",
    subline: "Dauert nur zwei Minuten.",
  });
  const stored = readCollection("brands").find((b) => b.slug === "patch-test");
  assert.equal(stored?.name, "Patch Test 2");
});

test("applyBrandPatch: meta wird tief gemerged, IDs überleben", () => {
  const next = applyBrandPatch("patch-test", {
    meta: { campaignTarget: { metric: "CPL", value: 38 } },
  });
  assert.deepEqual(next.meta.campaignTarget, { metric: "CPL", value: 38 });
  assert.equal(next.meta.campaignId, "demo-camp-9");
  assert.equal(next.meta.pageId, "demo-page-9");

  // null clears the campaign target back to the brand default.
  const cleared = applyBrandPatch("patch-test", { meta: { campaignTarget: null } });
  assert.equal("campaignTarget" in cleared.meta, false);
});

test("applyBrandPatch: unbekannte Brand wirft brand_not_found", () => {
  assert.throws(() => applyBrandPatch("does-not-exist", { name: "X" }), /brand_not_found/);
});
