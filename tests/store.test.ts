import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Point the store at a temp dir before importing it is not required —
// the store resolves ADLOOP_DATA_DIR lazily on every call.
import {
  createRun,
  finishRun,
  getBrandState,
  newId,
  readCollection,
  resolveCampaignTarget,
  setRunResult,
  upsert,
  writeCollection,
} from "../engine/store.ts";

let dir: string;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "adloop-store-test-"));
  process.env.ADLOOP_DATA_DIR = dir;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADLOOP_DATA_DIR;
});

test("read of a missing collection returns an empty array", () => {
  assert.deepEqual(readCollection("angles"), []);
});

test("write/read roundtrip and upsert by id", () => {
  const angle = {
    id: newId("ang"),
    brandSlug: "loyft",
    name: "Testwinkel",
    segment: "Test",
    pain: "Test",
    mechanism: "Test",
    hookDirection: "Test",
    status: "draft" as const,
    rationale: "Test",
  };
  writeCollection("angles", [angle]);
  assert.equal(readCollection("angles").length, 1);

  upsert("angles", { ...angle, status: "approved" });
  const rows = readCollection("angles");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "approved");
});

// Runs against the committed example brand — real brand data stays local
// and untracked (#17), so CI clones only carry brands/creators-demo/.
test("getBrandState seeds a brand from brands/<slug>/brand.json", () => {
  const state = getBrandState("creators-demo");
  assert.ok(state, "creators-demo state should exist via seed");
  assert.equal(state.brand.slug, "creators-demo");
  assert.equal(state.brand.conversionGoal, "website_lead");
  assert.ok(state.brand.targetCpa != null && state.brand.targetCpa > 0);
  assert.equal(state.angles.length, 0);
});

test("resolveCampaignTarget: Kampagnen-Ziel schlägt Brand-Fallback (#17)", () => {
  const state = getBrandState("creators-demo");
  assert.ok(state);
  // The example seed carries a campaign-level target …
  assert.deepEqual(state.economics.target, { metric: "CPL", value: 40 });
  // … without one, brand.targetCpa acts as CPA fallback.
  const brand = {
    ...state.brand,
    meta: { ...state.brand.meta, campaignTarget: undefined },
  };
  assert.deepEqual(resolveCampaignTarget(brand), {
    metric: "CPA",
    value: state.brand.targetCpa,
  });
  // Neither set -> no target (freshly onboarded brand).
  assert.equal(resolveCampaignTarget({ ...brand, targetCpa: null }), null);
});

test("getBrandState returns undefined for unknown brand", () => {
  assert.equal(getBrandState("does-not-exist"), undefined);
});

test("newId uses the prefix", () => {
  assert.match(newId("run"), /^run_[0-9a-f-]{12}$/);
});

test("createRun starts running, finishRun marks finished", () => {
  const run = createRun("loyft", "strategist");
  assert.equal(run.status, "running");
  assert.equal(run.finishedAt, null);

  finishRun(run.id);
  const stored = readCollection("runs").find((r) => r.id === run.id);
  assert.ok(stored?.finishedAt);
  assert.equal(stored?.status, "finished");
  assert.equal(stored?.error, undefined);
});

test("finishRun with error marks failed and is idempotent", () => {
  const run = createRun("loyft", "assets", "ang_test");
  assert.equal(run.angleId, "ang_test");

  finishRun(run.id, "boom");
  // Second finish (route backstop after agent) must not overwrite the first.
  finishRun(run.id);

  const stored = readCollection("runs").find((r) => r.id === run.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.error, "boom");
});

test("setRunResult persists a result readable from the collection", () => {
  const run = createRun("loyft", "optimize");
  setRunResult(run.id, { totals: { spend: 1 } });
  finishRun(run.id);
  const stored = readCollection("runs").find((r) => r.id === run.id);
  assert.deepEqual(stored?.result, { totals: { spend: 1 } });
});
