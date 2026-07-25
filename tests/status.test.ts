import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { isDemoMetaId, setDeliveryStatus } from "../engine/activation.ts";
import { readCollection, upsert } from "../engine/store.ts";
import type { Asset, Brand } from "../engine/types.ts";

let dir: string;
let savedToken: string | undefined;

const demoBrand: Brand = {
  slug: "status-demo",
  name: "Status Demo",
  url: "https://example.com",
  product: "Testprodukt für den Status-Toggle",
  conversionGoal: "website_lead",
  targetCpa: 30,
  guardrails: [],
  designTokens: {},
  meta: {
    adAccountId: "demo-act-1",
    pageId: "demo-page-1",
    pixelId: "",
    leadEventName: "Lead",
    geoCountries: ["DE"],
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    specialAdCategories: [],
    fixedDailyBudgetCents: null,
    campaignId: "demo-camp-1",
  },
};

const demoAsset: Asset = {
  id: "ast_statusdemo",
  angleId: "ang_statusdemo",
  kind: "static",
  payload: {},
  status: "published",
  metaIds: { creativeId: "demo-creative-1", adId: "demo-ad-1" },
};

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "adloop-status-test-"));
  process.env.ADLOOP_DATA_DIR = dir;
  // Without a token every Graph call throws immediately — the demo path must
  // never reach the connector, the real-ID path must.
  savedToken = process.env.META_ACCESS_TOKEN;
  delete process.env.META_ACCESS_TOKEN;
  upsert("brands", demoBrand);
  upsert("assets", demoAsset);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADLOOP_DATA_DIR;
  if (savedToken) process.env.META_ACCESS_TOKEN = savedToken;
});

test("isDemoMetaId erkennt simulierte IDs", () => {
  assert.equal(isDemoMetaId("demo-camp-1"), true);
  assert.equal(isDemoMetaId("000000000000000000"), false);
});

test("Demo-Kampagne: Store-Update ohne Graph-Call", async () => {
  const result = await setDeliveryStatus("demo-camp-1", "ACTIVE");
  assert.deepEqual(result, {
    id: "demo-camp-1",
    kind: "campaign",
    status: "ACTIVE",
    demo: true,
  });
  const stored = readCollection("brands").find((b) => b.slug === "status-demo");
  assert.equal(stored?.meta.campaignStatus, "ACTIVE");
});

test("Demo-Ad: Store-Update ohne Graph-Call, Toggle zurück auf PAUSED", async () => {
  const on = await setDeliveryStatus("demo-ad-1", "ACTIVE");
  assert.equal(on.kind, "ad");
  assert.equal(on.demo, true);

  const off = await setDeliveryStatus("demo-ad-1", "PAUSED");
  assert.equal(off.status, "PAUSED");
  const stored = readCollection("assets").find((a) => a.id === "ast_statusdemo");
  assert.equal(stored?.deliveryStatus, "PAUSED");
});

test("unbekannte ID wird abgelehnt (kein beliebiges Graph-Objekt)", async () => {
  await assert.rejects(
    () => setDeliveryStatus("demo-camp-does-not-exist", "ACTIVE"),
    /unknown_meta_id/,
  );
});

test("echte ID nimmt den Graph-Pfad (scheitert hier kontrolliert an fehlendem Token)", async () => {
  upsert("brands", {
    ...demoBrand,
    slug: "status-real",
    meta: { ...demoBrand.meta, campaignId: "120200000000000001" },
  });
  await assert.rejects(
    () => setDeliveryStatus("120200000000000001", "ACTIVE"),
    /META_ACCESS_TOKEN/,
  );
  // No store write when the Graph call fails.
  const stored = readCollection("brands").find((b) => b.slug === "status-real");
  assert.equal(stored?.meta.campaignStatus, undefined);
});
