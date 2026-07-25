// JSON file store per SPEC.md §0: one file per collection under data/,
// atomic writes (tmp file + rename). No SQL, no ORM — the app runs locally
// on demo day, a single Node process is the only writer.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  Angle,
  Asset,
  Brand,
  BrandState,
  Evidence,
  Learning,
  Run,
} from "./types.ts";

export type CollectionName =
  | "brands"
  | "evidence"
  | "angles"
  | "assets"
  | "runs"
  | "learnings";

interface CollectionTypes {
  brands: Brand;
  evidence: Evidence;
  angles: Angle;
  assets: Asset;
  runs: Run;
  learnings: Learning;
}

export function dataDir(): string {
  return process.env.ADLOOP_DATA_DIR ?? path.join(process.cwd(), "data");
}

function filePath(name: CollectionName): string {
  return path.join(dataDir(), `${name}.json`);
}

export function readCollection<N extends CollectionName>(
  name: N,
): CollectionTypes[N][] {
  const file = filePath(name);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trim() === "") return [];
  return JSON.parse(raw) as CollectionTypes[N][];
}

export function writeCollection<N extends CollectionName>(
  name: N,
  rows: CollectionTypes[N][],
): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = filePath(name);
  // Atomic write: rename within the same directory is atomic on POSIX.
  const tmp = path.join(dir, `.${name}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

export function upsert<N extends CollectionName>(
  name: N,
  row: CollectionTypes[N] & { id?: string; slug?: string },
): void {
  const key = "id" in row && row.id ? "id" : "slug";
  const rows = readCollection(name);
  const idx = rows.findIndex(
    (r) =>
      (r as unknown as Record<string, unknown>)[key] ===
      (row as unknown as Record<string, unknown>)[key],
  );
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
  writeCollection(name, rows);
}

export function getBrand(slug: string): Brand | undefined {
  return readCollection("brands").find((b) => b.slug === slug);
}

// Seeds the store from brands/<slug>/brand.json if the brand is missing.
export function ensureBrandSeed(slug: string): Brand | undefined {
  const existing = getBrand(slug);
  if (existing) return existing;
  const seedFile = path.join(process.cwd(), "brands", slug, "brand.json");
  if (!fs.existsSync(seedFile)) return undefined;
  const brand = JSON.parse(fs.readFileSync(seedFile, "utf8")) as Brand;
  upsert("brands", brand);
  return brand;
}

export function getBrandState(slug: string): BrandState | undefined {
  const brand = ensureBrandSeed(slug);
  if (!brand) return undefined;
  const angles = readCollection("angles").filter((a) => a.brandSlug === slug);
  const angleIds = new Set(angles.map((a) => a.id));
  return {
    brand,
    evidence: readCollection("evidence").filter((e) => e.brandSlug === slug),
    angles,
    assets: readCollection("assets").filter((a) => angleIds.has(a.angleId)),
    runs: readCollection("runs").filter((r) => r.brandSlug === slug),
    learnings: readCollection("learnings").filter((l) => l.brandSlug === slug),
  };
}

export function createRun(brandSlug: string, stage: string): Run {
  const run: Run = {
    id: newId("run"),
    brandSlug,
    stage,
    log: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  upsert("runs", run);
  return run;
}

export function finishRun(runId: string): void {
  const runs = readCollection("runs");
  const run = runs.find((r) => r.id === runId);
  if (!run) return;
  run.finishedAt = new Date().toISOString();
  writeCollection("runs", runs);
}

export function appendRunLog(
  runId: string,
  agent: string,
  message: string,
  level: "info" | "warn" | "error" = "info",
): void {
  const runs = readCollection("runs");
  const run = runs.find((r) => r.id === runId);
  if (!run) return;
  run.log.push({ ts: new Date().toISOString(), agent, message, level });
  writeCollection("runs", runs);
}
