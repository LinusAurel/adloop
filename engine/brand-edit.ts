// Brand editing (#17) — applies a validated PATCH (brandPatchSchema) to a
// brand. Writes BOTH stores: the JSON store row (runtime truth for /state)
// and brands/<slug>/brand.json when it exists (the human-owned seed the
// Publisher reads fresh on every publish). meta is deep-merged so publisher
// IDs and account config survive partial edits.

import fs from "node:fs";
import path from "node:path";
import type { BrandPatch } from "./schemas.ts";
import { ensureBrandSeed, upsert } from "./store.ts";
import type { Brand } from "./types.ts";

export function applyBrandPatch(slug: string, patch: BrandPatch): Brand {
  const brand = ensureBrandSeed(slug);
  if (!brand) throw new Error("brand_not_found");

  const { meta: metaPatch, ...topLevel } = patch;
  // null clears the optional campaign target entirely instead of storing null.
  const { campaignTarget, ...metaRest } = metaPatch ?? {};
  const nextMeta = { ...brand.meta, ...metaRest };
  if (campaignTarget) nextMeta.campaignTarget = campaignTarget;
  else if (campaignTarget === null) delete nextMeta.campaignTarget;

  const next: Brand = { ...brand, ...topLevel, meta: nextMeta };
  upsert("brands", next);

  const seedFile = path.join(process.cwd(), "brands", slug, "brand.json");
  if (fs.existsSync(seedFile)) {
    const raw = JSON.parse(fs.readFileSync(seedFile, "utf8")) as Record<string, unknown>;
    const rawMeta = (raw.meta ?? {}) as Record<string, unknown>;
    const mergedMeta: Record<string, unknown> = { ...rawMeta, ...metaRest };
    if (campaignTarget) mergedMeta.campaignTarget = campaignTarget;
    else if (campaignTarget === null) delete mergedMeta.campaignTarget;
    const merged: Record<string, unknown> = { ...raw, ...topLevel, meta: mergedMeta };
    fs.writeFileSync(seedFile, JSON.stringify(merged, null, 2) + "\n", "utf8");
  }
  return next;
}
