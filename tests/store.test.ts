import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Point the store at a temp dir before importing it is not required —
// the store resolves ADLOOP_DATA_DIR lazily on every call.
import {
  getBrandState,
  newId,
  readCollection,
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

test("getBrandState seeds loyft from brands/loyft/brand.json", () => {
  const state = getBrandState("loyft");
  assert.ok(state, "loyft state should exist via seed");
  assert.equal(state.brand.slug, "loyft");
  assert.equal(state.brand.name, "loyft");
  assert.equal(state.brand.conversionGoal, "website_lead");
  assert.ok(state.brand.targetCpa > 0);
  assert.deepEqual(state.angles.length, 1); // from previous test, same data dir
});

test("getBrandState returns undefined for unknown brand", () => {
  assert.equal(getBrandState("does-not-exist"), undefined);
});

test("newId uses the prefix", () => {
  assert.match(newId("run"), /^run_[0-9a-f-]{12}$/);
});
