import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/guard";
import { dataDir } from "@/engine/store";

// Mirrors scripts/demo.mjs `load`: copies the versioned creators-demo fixture
// state into the JSON store. Needed on deployments without shell access —
// the store there starts empty, so the demo brand has to be seeded via API.
const DEMO_SLUG = "creators-demo";
const COLLECTIONS = ["brands", "evidence", "angles", "assets", "runs", "learnings"] as const;

type Row = Record<string, unknown> & { id?: string };

function fixtureDir(): string {
  return path.join(process.cwd(), "data", "fixtures", "demo");
}

function readJson(file: string): Row[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  return raw.trim() === "" ? [] : (JSON.parse(raw) as Row[]);
}

function isDemoRow(name: string, row: Row, demoAngleIds: Set<string>): boolean {
  if (name === "brands") return row.slug === DEMO_SLUG;
  if (name === "assets") {
    return demoAngleIds.has(String(row.angleId)) || String(row.id).startsWith("ast_demo");
  }
  return row.brandSlug === DEMO_SLUG;
}

// Shift run timestamps so the freshest run is ~10 minutes old — the ticker
// must never look stale in a demo.
function shiftRunTimestamps(runs: Row[]): Row[] {
  const times = runs
    .flatMap((r) => [r.startedAt, r.finishedAt].filter(Boolean))
    .map((t) => new Date(String(t)).getTime());
  if (times.length === 0) return runs;
  const delta = Date.now() - 10 * 60 * 1000 - Math.max(...times);
  const shift = (ts: unknown) =>
    ts ? new Date(new Date(String(ts)).getTime() + delta).toISOString() : ts;
  return runs.map((run) => ({
    ...run,
    startedAt: shift(run.startedAt),
    finishedAt: shift(run.finishedAt),
    log: ((run.log as Row[]) ?? []).map((entry) => ({ ...entry, ts: shift(entry.ts) })),
  }));
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const fixtures = fixtureDir();
  if (!fs.existsSync(fixtures)) {
    return NextResponse.json({ ok: false, error: "fixtures_missing" }, { status: 500 });
  }

  const demoAngleIds = new Set(
    readJson(path.join(fixtures, "angles.json")).map((a) => String(a.id)),
  );
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });

  const counts: Record<string, number> = {};
  for (const name of COLLECTIONS) {
    const kept = readJson(path.join(dir, `${name}.json`)).filter(
      (row) => !isDemoRow(name, row, demoAngleIds),
    );
    let fixture = readJson(path.join(fixtures, `${name}.json`));
    if (name === "runs") fixture = shiftRunTimestamps(fixture);
    const tmp = path.join(dir, `.${name}.demo.tmp`);
    fs.writeFileSync(tmp, JSON.stringify([...kept, ...fixture], null, 2) + "\n", "utf8");
    fs.renameSync(tmp, path.join(dir, `${name}.json`));
    counts[name] = fixture.length;
  }

  let images = 0;
  const srcImages = path.join(fixtures, "assets");
  if (fs.existsSync(srcImages)) {
    const destImages = path.join(dir, "assets");
    fs.mkdirSync(destImages, { recursive: true });
    for (const file of fs.readdirSync(srcImages)) {
      if (!file.endsWith(".png")) continue;
      fs.copyFileSync(path.join(srcImages, file), path.join(destImages, file));
      images += 1;
    }
  }

  return NextResponse.json({ ok: true, brand: DEMO_SLUG, counts, images });
}
