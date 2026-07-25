import assert from "node:assert/strict";
import { test } from "node:test";

import type { AnalysisResult } from "../engine/agents/analyst.ts";
import {
  buildBriefingPrompt,
  buildFallbackScript,
  isSafeBriefingFileName,
  summarizeAnalysis,
} from "../engine/agents/briefing.ts";
import type { Learning } from "../engine/types.ts";

const analysis: AnalysisResult = {
  runId: "run_x",
  source: "fixture",
  note: "Demo-Daten",
  totals: { spend: 214.5, leads: 11, cpl: 19.5 },
  targetCpa: 100,
  rows: [
    {
      adId: "1",
      adName: "LOYFT_ANG-A_AST-B_4X5_V1",
      spend: 120,
      impressions: 10000,
      clicks: 300,
      leads: 8,
      cpl: 15,
      classification: "winner",
      reason: "8 Leads bei CPL 15,00 €",
    },
    {
      adId: "2",
      adName: "LOYFT_ANG-C_AST-D_4X5_V1",
      spend: 94.5,
      impressions: 9000,
      clicks: 120,
      leads: 0,
      cpl: null,
      classification: "loser",
      reason: "94,50 € Spend ohne einen einzigen Lead",
    },
  ],
  learnings: [],
  recommendation: "Winner-Angle ausbauen.",
};

const learnings: Learning[] = [
  {
    id: "lrn_1",
    brandSlug: "loyft",
    source: "meta_insights",
    pattern: "[Demo-Daten] Winner: Grundversorgung-Falle",
    evidenceRefs: ["1"],
  },
];

test("summarizeAnalysis nennt Winner, Loser, CPL-Ziel und Fixture-Label", () => {
  const summary = summarizeAnalysis(analysis, learnings);
  assert.match(summary, /Demo-Fixture/);
  assert.match(summary, /1 Winner, 1 Loser/);
  assert.match(summary, /Ziel-CPA ≤ 100 €/);
  assert.match(summary, /LOYFT_ANG-A_AST-B_4X5_V1/);
  assert.match(summary, /Empfehlung: Winner-Angle ausbauen\./);
});

test("buildBriefingPrompt transportiert Summary und 30-Sekunden-Vorgabe", () => {
  const prompt = buildBriefingPrompt("loyft", "SUMMARY-MARKER");
  assert.match(prompt, /30 Sekunden/);
  assert.match(prompt, /SUMMARY-MARKER/);
  assert.match(prompt, /loyft/);
});

test("buildFallbackScript ist einzeilig und gedeckelt", () => {
  const script = buildFallbackScript("loyft", "a\n".repeat(2000));
  assert.ok(!script.includes("\n"));
  assert.ok(script.length <= 1200);
});

test("isSafeBriefingFileName blockt Traversal und fremde Slugs", () => {
  assert.equal(isSafeBriefingFileName("loyft", "loyft-1753440000000.mp3"), true);
  assert.equal(isSafeBriefingFileName("loyft", "../loyft-1.mp3"), false);
  assert.equal(isSafeBriefingFileName("loyft", "other-1.mp3"), false);
  assert.equal(isSafeBriefingFileName("loyft", "loyft-1.mp4"), false);
});
