import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { ensureBrandSeed, readCollection } from "@/engine/store";

export const dynamic = "force-dynamic";

// GET /api/brands -> [{ slug, name }] für den Brand-Switcher im UI.
// Seed-Brands aus brands/<slug>/brand.json werden vorher in den Store
// gespiegelt, damit die Liste auch nach einem frischen data/-Wipe stimmt.
export async function GET() {
  const brandsDir = path.join(process.cwd(), "brands");
  if (fs.existsSync(brandsDir)) {
    for (const entry of fs.readdirSync(brandsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(brandsDir, entry.name, "brand.json"))) {
        ensureBrandSeed(entry.name);
      }
    }
  }
  const brands = readCollection("brands").map((b) => ({
    slug: b.slug,
    name: b.name,
  }));
  return NextResponse.json({ ok: true, brands });
}
