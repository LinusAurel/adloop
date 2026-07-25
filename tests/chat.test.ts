// Chat-Agent (#16): Mock-Pfad und Brand-Isolation. Ohne ANTHROPIC_API_KEY
// muss runChat eine deterministische englische Antwort mit State-Zusammenfassung
// liefern (Produkt-UI ist Englisch); die Tools dürfen strikt nur Daten der eigenen Brand lesen
// und verändern. Store über ADLOOP_DATA_DIR in ein Temp-Verzeichnis umgeleitet
// (node --test startet pro Testdatei einen eigenen Prozess).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Deterministic mock mode + isolated store — set BEFORE engine imports so no
// module can capture the real environment first.
delete process.env.ANTHROPIC_API_KEY;
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "adloop-chat-"));
process.env.ADLOOP_DATA_DIR = tmpDataDir;

const { executeChatTool, runChat } = await import("../engine/chat.ts");
const { readCollection, writeCollection } = await import("../engine/store.ts");

import type { Angle, Brand } from "../engine/types.ts";

function makeBrand(slug: string, name: string): Brand {
  return {
    slug,
    name,
    url: `https://${slug}.example`,
    product: `Testprodukt von ${name}`,
    conversionGoal: "website_lead",
    targetCpa: 20,
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

function makeAngle(id: string, brandSlug: string, name: string): Angle {
  return {
    id,
    brandSlug,
    name,
    segment: `Segment von ${brandSlug}`,
    pain: "Ein Schmerzpunkt",
    mechanism: "Ein Mechanismus",
    hookDirection: "Ein Hook",
    status: "draft",
    expectedCpl: 12,
    rationale: "Testdatensatz",
  };
}

const ANGLE_A = "ang_chat-brand-a";
const ANGLE_B = "ang_chat-brand-b";

writeCollection("brands", [
  makeBrand("chat-brand-a", "Alpha Marke"),
  makeBrand("chat-brand-b", "Beta Marke"),
]);
writeCollection("angles", [
  makeAngle(ANGLE_A, "chat-brand-a", "Alpha-Exklusiv-Angle"),
  makeAngle(ANGLE_B, "chat-brand-b", "Beta-Geheim-Angle"),
]);

test("Mock-Pfad: deterministische Antwort mit State-Zusammenfassung", async () => {
  const result = await runChat("chat-brand-a", [
    { role: "user", content: "Wie ist der Stand?" },
  ]);

  assert.match(result.reply, /MOCK/, "Antwort muss den Mock-Modus benennen");
  assert.match(result.reply, /Current state of the brand/, "Mock-Antwort ist englisch");
  assert.match(result.reply, /Alpha Marke/);
  assert.match(result.reply, /Alpha-Exklusiv-Angle/);
  assert.equal(result.stateChanged, false);
  assert.ok(Array.isArray(result.actions));
});

test("Brand-Isolation: Chat für Brand A liefert keine Daten von Brand B", async () => {
  const result = await runChat("chat-brand-a", [
    { role: "user", content: "Zeig mir alle Angles." },
  ]);

  assert.doesNotMatch(result.reply, /Beta-Geheim-Angle/);
  assert.doesNotMatch(result.reply, /Beta Marke/);
  assert.doesNotMatch(result.reply, /chat-brand-b/);
});

test("Brand-Isolation: Tools mutieren keine fremden Angles", async () => {
  const outcome = await executeChatTool("chat-brand-a", "approve_angle", {
    angleId: ANGLE_B,
  });
  assert.equal(outcome.isError, true);
  assert.notEqual(outcome.mutated, true);

  const angleB = readCollection("angles").find((a) => a.id === ANGLE_B);
  assert.equal(angleB?.status, "draft", "fremder Angle darf nie mutieren");
});

test("Brand-Isolation: Tools mutieren keine fremden Assets", async () => {
  writeCollection("assets", [
    {
      id: "ast_chat-brand-b",
      angleId: ANGLE_B,
      kind: "ad_copy",
      payload: {},
      status: "draft",
    },
  ]);

  const outcome = await executeChatTool("chat-brand-a", "approve_asset", {
    assetId: "ast_chat-brand-b",
  });
  assert.equal(outcome.isError, true);

  const asset = readCollection("assets").find((a) => a.id === "ast_chat-brand-b");
  assert.equal(asset?.status, "draft", "fremdes Asset darf nie mutieren");
});

test("Eigene Angles lassen sich per Tool freigeben und verwerfen", async () => {
  const approve = await executeChatTool("chat-brand-a", "approve_angle", {
    angleId: ANGLE_A,
  });
  assert.notEqual(approve.isError, true);
  assert.equal(approve.mutated, true);
  assert.equal(
    readCollection("angles").find((a) => a.id === ANGLE_A)?.status,
    "approved",
  );

  const reject = await executeChatTool("chat-brand-a", "reject_angle", {
    angleId: ANGLE_A,
  });
  assert.equal(reject.mutated, true);
  assert.equal(
    readCollection("angles").find((a) => a.id === ANGLE_A)?.status,
    "killed",
  );
});

test("update_brand_data ändert nur erlaubte Felder der eigenen Brand", async () => {
  const outcome = await executeChatTool("chat-brand-a", "update_brand_data", {
    targetCpa: 25,
    product: "Neues Testprodukt",
  });
  assert.notEqual(outcome.isError, true);
  assert.equal(outcome.mutated, true);

  const brands = readCollection("brands");
  const brandA = brands.find((b) => b.slug === "chat-brand-a");
  const brandB = brands.find((b) => b.slug === "chat-brand-b");
  assert.equal(brandA?.targetCpa, 25);
  assert.equal(brandA?.product, "Neues Testprodukt");
  assert.equal(brandB?.targetCpa, 20, "fremde Brand bleibt unberührt");
});

test("publish_campaign verweigert ohne menschliche Meta-Konfiguration", async () => {
  const outcome = await executeChatTool("chat-brand-a", "publish_campaign", {});
  assert.equal(outcome.isError, true);
  assert.match(outcome.result, /human/);
});

test("runChat wirft brand_not_found für unbekannte Brands", async () => {
  await assert.rejects(
    () => runChat("gibt-es-nicht", [{ role: "user", content: "Hallo" }]),
    /brand_not_found/,
  );
});

after(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.ADLOOP_DATA_DIR;
});
