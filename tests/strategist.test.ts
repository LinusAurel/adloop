// Brand-Isolation des Strategist (#12): Ein Run für Brand B darf niemals
// Angles unter Brand A erzeugen oder verändern — auch nicht im Mock-Modus,
// dessen Payload die Zod-Validierung umgeht. Der Store wird über
// ADLOOP_DATA_DIR in ein Temp-Verzeichnis umgeleitet; node --test startet
// pro Testdatei einen eigenen Prozess, andere Tests bleiben unberührt.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Deterministic mock mode + isolated store — set BEFORE engine imports so no
// module can capture the real environment first.
delete process.env.ANTHROPIC_API_KEY;
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adloop-strategist-"));
process.env.ADLOOP_DATA_DIR = tmpDataDir;

const { draftsToAngles, runStrategist } = await import("../engine/agents/strategist.ts");
const { readCollection, writeCollection } = await import("../engine/store.ts");

import type { Angle, Brand } from "../engine/types.ts";

function makeBrand(slug: string, name: string): Brand {
  return {
    slug,
    name,
    url: `https://${slug}.example`,
    product: "Testprodukt",
    conversionGoal: "website_lead",
    targetCpa: null,
    guardrails: ["Keine Heilversprechen"],
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

const brandAAngle: Angle = {
  id: "ang_brand-a-0001",
  brandSlug: "brand-a",
  status: "approved",
  name: "Bestehender Brand-A-Angle",
  segment: "Bestandskunden von Brand A",
  pain: "Ein echter Schmerzpunkt, der Brand A gehört",
  mechanism: "Ein Mechanismus, der Brand A gehört und so bleiben muss",
  hookDirection: "Ein Hook, der Brand A gehört",
  expectedCpl: 12,
  rationale: "Vorbestand: dieser Datensatz darf durch fremde Runs nie mutieren.",
};

function seedStore(): void {
  writeCollection("brands", [makeBrand("brand-a", "Brand A"), makeBrand("brand-b", "Brand B")]);
  writeCollection("angles", [brandAAngle]);
  writeCollection("evidence", []);
  writeCollection("runs", []);
}

test("Strategist für Brand B erzeugt/ändert nie Angles unter Brand A", async () => {
  seedStore();
  const before = JSON.stringify(
    readCollection("angles").filter((a) => a.brandSlug === "brand-a"),
  );

  const { angles } = await runStrategist("brand-b");

  assert.ok(angles.length > 0, "Mock-Run muss Angles liefern");
  for (const angle of angles) {
    assert.equal(angle.brandSlug, "brand-b");
    assert.equal(angle.status, "draft");
  }

  const after = readCollection("angles");
  const brandAAfter = after.filter((a) => a.brandSlug === "brand-a");
  assert.equal(JSON.stringify(brandAAfter), before, "Brand-A-Angles müssen unverändert bleiben");
  const foreign = after.filter((a) => a.brandSlug !== "brand-a" && a.brandSlug !== "brand-b");
  assert.equal(foreign.length, 0, "kein Angle unter einem dritten Slug");
});

test("zweiter Mock-Run dupliziert keine Angles (Namens-Guard pro Brand)", async () => {
  seedStore();
  await runStrategist("brand-b");
  const countAfterFirst = readCollection("angles").filter((a) => a.brandSlug === "brand-b").length;

  await runStrategist("brand-b");
  const countAfterSecond = readCollection("angles").filter((a) => a.brandSlug === "brand-b").length;

  assert.equal(countAfterSecond, countAfterFirst, "identische Mock-Namen dürfen nicht erneut angelegt werden");
});

test("draftsToAngles: Draft-Felder können id/brandSlug/status nicht überschreiben", () => {
  // Simulates an unvalidated (mock) payload that smuggles ownership fields in.
  const malicious = {
    name: "Eingeschleuster Angle",
    segment: "Segment X mit genug Zeichen",
    pain: "Ein Schmerzpunkt mit genug Zeichen für das Schema",
    mechanism: "Ein Mechanismus mit genug Zeichen für das Schema",
    hookDirection: "Hook-Richtung X",
    expectedCpl: 10,
    rationale: "Eine Begründung, die lang genug für das Schema ist.",
    brandSlug: "brand-a",
    status: "approved",
    id: "ang_hijacked",
  };
  const [angle] = draftsToAngles([malicious], "brand-b");
  assert.equal(angle.brandSlug, "brand-b");
  assert.equal(angle.status, "draft");
  assert.notEqual(angle.id, "ang_hijacked");
});
