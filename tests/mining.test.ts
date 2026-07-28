import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyRow,
  classifyRows,
  loadFixtureRows,
  MIN_LEADS,
  MIN_SPEND_EUR,
  normalizeRow,
  type NormalizedAdRow,
} from "../engine/agents/analyst.ts";
import { buildAdName, buildCampaignName, parseAdName } from "../engine/naming.ts";

const TARGET_CPA = 100;

function row(overrides: Partial<NormalizedAdRow>): NormalizedAdRow {
  return {
    adId: "1",
    adName: "ADLOOP-TEST_ANG-X_AST-Y_4X5_V1",
    spend: 0,
    impressions: 0,
    clicks: 0,
    leads: 0,
    cpl: null,
    ...overrides,
  };
}

test("normalizeRow: Strings werden Zahlen, Lead-Mapping ohne Doppelzählung", () => {
  const n = normalizeRow({
    ad_id: "42",
    ad_name: "ADLOOP-LOYFT_ANG-ABC_AST-DEF_4X5_V1",
    spend: "96.20",
    impressions: "18342",
    clicks: "412",
    actions: [
      { action_type: "link_click", value: "398" },
      // aggregate AND pixel twin present -> must count once, not 6
      { action_type: "lead", value: "3" },
      { action_type: "offsite_conversion.fb_pixel_lead", value: "3" },
    ],
  });
  assert.equal(n.spend, 96.2);
  assert.equal(n.impressions, 18342);
  assert.equal(n.leads, 3);
  assert.ok(n.cpl && Math.abs(n.cpl - 32.066) < 0.01);
  assert.equal(n.angleId, "ang_abc");
  assert.equal(n.assetId, "ast_def");
});

test("normalizeRow: nur Pixel-Twin vorhanden -> wird gemappt", () => {
  const n = normalizeRow({
    ad_id: "43",
    spend: "50",
    actions: [{ action_type: "offsite_conversion.fb_pixel_lead", value: "2" }],
  });
  assert.equal(n.leads, 2);
});

test("normalizeRow: keine actions / kaputte Werte -> definierte Nullen", () => {
  const n = normalizeRow({ ad_id: "44", spend: "abc" });
  assert.equal(n.spend, 0);
  assert.equal(n.leads, 0);
  assert.equal(n.cpl, null);
});

test("classify: Winner braucht BEIDE Schwellen plus CPL im Ziel", () => {
  const winner = classifyRow(row({ spend: 96.2, leads: 3, cpl: 96.2 / 3 }), TARGET_CPA);
  assert.equal(winner.classification, "winner");

  // exact thresholds still count
  const boundary = classifyRow(
    row({ spend: MIN_SPEND_EUR, leads: MIN_LEADS, cpl: MIN_SPEND_EUR / MIN_LEADS }),
    TARGET_CPA,
  );
  assert.equal(boundary.classification, "winner");
});

test("classify: Kleinstmengen-Fall — 1 billiger Lead bei 6,42 € ist KEIN Winner", () => {
  const fluke = classifyRow(row({ spend: 6.42, leads: 1, cpl: 6.42 }), TARGET_CPA);
  assert.equal(fluke.classification, "insufficient_data");
});

test("classify: Spend ohne Lead ist Loser, CPL über Ziel ist Loser", () => {
  const noLead = classifyRow(row({ spend: 41.37, leads: 0, cpl: null }), TARGET_CPA);
  assert.equal(noLead.classification, "loser");

  const expensive = classifyRow(row({ spend: 123.5, leads: 1, cpl: 123.5 }), TARGET_CPA);
  assert.equal(expensive.classification, "loser");
});

test("classify: CPL im Rahmen, aber unter Lead-Schwelle -> zu wenig Daten", () => {
  const fewLeads = classifyRow(row({ spend: 28.9, leads: 1, cpl: 28.9 }), TARGET_CPA);
  assert.equal(fewLeads.classification, "insufficient_data");
});

test("Fixture: 6 Ads, 2 Winner, 2 Loser, 2x zu wenig Daten", () => {
  const rows = classifyRows(loadFixtureRows("creators-demo"), TARGET_CPA);
  assert.equal(rows.length, 6);
  const count = (c: string) => rows.filter((r) => r.classification === c).length;
  assert.equal(count("winner"), 2);
  assert.equal(count("loser"), 2);
  assert.equal(count("insufficient_data"), 2);
});

test("Naming: build + parse sind Umkehrfunktionen", () => {
  const name = buildAdName({
    brandSlug: "loyft",
    angleId: "ang_abc123",
    assetId: "ast_def456",
  });
  assert.equal(name, "ADLOOP-LOYFT_ANG-ABC123_AST-DEF456_4X5_V1");
  const parsed = parseAdName(name);
  assert.ok(parsed);
  assert.equal(parsed.brandSlug, "loyft");
  assert.equal(parsed.angleId, "ang_abc123");
  assert.equal(parsed.assetId, "ast_def456");
  assert.equal(parsed.version, 1);

  // foreign names in the account must not parse
  assert.equal(parseAdName("Fremde Kampagne | Ad 7"), undefined);
});

test("Naming: Campaign-Schema {BRAND}_{ROLE}_{OBJECTIVE}_{BUDGET}_{BID}_{YYYYMMDD}", () => {
  const name = buildCampaignName({ brandSlug: "loyft", date: new Date(2026, 6, 25) });
  assert.equal(name, "ADLOOP-LOYFT_CORE_LEADS_CBO_HV_20260725");
});
