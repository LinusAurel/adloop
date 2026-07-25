#!/usr/bin/env node
// Demo-Modus (#13): kopiert den versionierten Fixture-Zustand der Brand
// „creators-demo“ aus data/fixtures/demo/ in den JSON-Store unter data/ —
// andere Brands (z. B. loyft) bleiben unberührt. „clear“ entfernt genau
// diese Zeilen wieder. Kein Laufzeit-Flag: die App behandelt die Brand wie
// jede andere; nur der Analyst erkennt die simulierten Meta-IDs (demo-…).
//
//   node scripts/demo.mjs load    # Demo-Brand in den Store spiegeln
//   node scripts/demo.mjs clear   # Demo-Brand wieder entfernen
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.ADLOOP_DATA_DIR ?? path.join(root, "data");
const fixtureDir = path.join(root, "data", "fixtures", "demo");

const DEMO_SLUG = "creators-demo";
const COLLECTIONS = ["brands", "evidence", "angles", "assets", "runs", "learnings"];

function readJson(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  return raw.trim() === "" ? [] : JSON.parse(raw);
}

function writeStore(name, rows) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, `${name}.json`);
  const tmp = path.join(dataDir, `.${name}.demo.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// Demo-Zeilen erkennen: Brand über den Slug, Assets über die Angle-IDs der
// Fixture (Assets tragen selbst keinen brandSlug).
function isDemoRow(name, row, demoAngleIds) {
  if (name === "brands") return row.slug === DEMO_SLUG;
  if (name === "assets") return demoAngleIds.has(row.angleId) || String(row.id).startsWith("ast_demo");
  return row.brandSlug === DEMO_SLUG;
}

// Run-Zeitstempel beim Laden so verschieben, dass der jüngste Lauf ~10 min
// zurückliegt — der Ticker sieht damit immer frisch aus.
function shiftRunTimestamps(runs) {
  const times = runs.flatMap((r) => [r.startedAt, r.finishedAt].filter(Boolean));
  if (times.length === 0) return runs;
  const max = Math.max(...times.map((t) => new Date(t).getTime()));
  const delta = Date.now() - 10 * 60 * 1000 - max;
  const shift = (ts) => (ts ? new Date(new Date(ts).getTime() + delta).toISOString() : ts);
  return runs.map((run) => ({
    ...run,
    startedAt: shift(run.startedAt),
    finishedAt: shift(run.finishedAt),
    log: run.log.map((entry) => ({ ...entry, ts: shift(entry.ts) })),
  }));
}

function demoAngleIdsFromFixture() {
  return new Set(readJson(path.join(fixtureDir, "angles.json")).map((a) => a.id));
}

function copyImages() {
  const src = path.join(fixtureDir, "assets");
  const dest = path.join(dataDir, "assets");
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const file of fs.readdirSync(src)) {
    if (!file.endsWith(".png")) continue;
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
    n += 1;
  }
  return n;
}

function removeImages() {
  const src = path.join(fixtureDir, "assets");
  const dest = path.join(dataDir, "assets");
  if (!fs.existsSync(src) || !fs.existsSync(dest)) return 0;
  let n = 0;
  for (const file of fs.readdirSync(src)) {
    const target = path.join(dest, file);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      n += 1;
    }
  }
  return n;
}

function load() {
  const demoAngleIds = demoAngleIdsFromFixture();
  for (const name of COLLECTIONS) {
    const kept = readJson(path.join(dataDir, `${name}.json`)).filter(
      (row) => !isDemoRow(name, row, demoAngleIds),
    );
    let fixture = readJson(path.join(fixtureDir, `${name}.json`));
    if (name === "runs") fixture = shiftRunTimestamps(fixture);
    writeStore(name, [...kept, ...fixture]);
    console.log(`demo:load ${name}: ${fixture.length} Demo-Zeilen (übrige Brands: unverändert)`);
  }
  console.log(`demo:load Statics: ${copyImages()} Bilder nach data/assets/ kopiert`);
  console.log(`demo:load fertig — Brand „${DEMO_SLUG}“ ist im Store.`);
}

function clear() {
  const demoAngleIds = demoAngleIdsFromFixture();
  for (const name of COLLECTIONS) {
    const rows = readJson(path.join(dataDir, `${name}.json`));
    const kept = rows.filter((row) => !isDemoRow(name, row, demoAngleIds));
    if (kept.length !== rows.length) writeStore(name, kept);
    console.log(`demo:clear ${name}: ${rows.length - kept.length} Demo-Zeilen entfernt`);
  }
  console.log(`demo:clear Statics: ${removeImages()} Bilder aus data/assets/ entfernt`);
  console.log(`demo:clear fertig — Brand „${DEMO_SLUG}“ ist aus dem Store entfernt.`);
}

const cmd = process.argv[2];
if (cmd === "load") load();
else if (cmd === "clear") clear();
else {
  console.error("usage: node scripts/demo.mjs <load|clear>");
  process.exit(1);
}
