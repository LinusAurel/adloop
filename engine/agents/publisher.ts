// Stage 6 — Publisher (SPEC §3/§5): approved assets -> Meta, ALL PAUSED
// (Hard Stop 2, enforced inside connectors/meta.ts — no status parameter
// exists). Idempotent: campaign/ad set are only created when brand.meta has
// no IDs yet; assets that already carry metaIds.adId are skipped. Every
// created ID is persisted immediately (store + brands/<slug>/brand.json) —
// attribution runs over ad_id -> Asset -> Angle, names are human fallback.

import fs from "node:fs";
import path from "node:path";
import { createAd, createCreative, uploadImage } from "../connectors/meta.ts";
import { buildAdName } from "../naming.ts";
import { ensureSingleCboBroad } from "../playbooks/single-cbo-broad.ts";
import { getBrand, readCollection, upsert } from "../store.ts";
import type { Asset, Brand } from "../types.ts";
import { endRun, logLine, startRun } from "./run.ts";

const AGENT = "Publisher";

interface StaticPayload {
  imageUrl?: string;
  localPath?: string;
  brief?: { textInImage?: string };
}

interface CopyPayload {
  variants?: { hook?: string; primary?: string; headline?: string; cta?: string }[];
  chosenIndex?: number;
}

export interface PublishedAd {
  assetId: string;
  angleId: string;
  adName: string;
  creativeId: string;
  adId: string;
}

export interface PublishResult {
  runId: string;
  campaignId: string;
  adsetId: string;
  published: PublishedAd[];
  skipped: { assetId: string; reason: string }[];
  notes: string[];
}

function seedPath(slug: string): string {
  return path.join(process.cwd(), "brands", slug, "brand.json");
}

// Brand config comes fresh from the seed file (budget, page, account are
// human-owned there); campaign/adset IDs are merged in from wherever they
// were persisted last (seed or store).
function loadBrandForPublish(slug: string): { brand: Brand; raw: Record<string, unknown> } {
  const file = seedPath(slug);
  if (!fs.existsSync(file)) throw new Error(`brand_not_found: ${slug}`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const brand = raw as unknown as Brand;
  const stored = getBrand(slug);
  brand.meta.campaignId = brand.meta.campaignId || stored?.meta.campaignId;
  brand.meta.adsetId = brand.meta.adsetId || stored?.meta.adsetId;
  return { brand, raw };
}

function persistBrand(brand: Brand, raw: Record<string, unknown>): void {
  upsert("brands", brand);
  // Seed file too, so idempotency survives a wiped data/ directory.
  fs.writeFileSync(seedPath(brand.slug), JSON.stringify(raw, null, 2) + "\n", "utf8");
}

// Fallback copy if an approved static has no companion ad_copy asset.
// Written to the loyft guardrails (loyft lowercase, Du capitalized, no
// dashes, allowed claim wording) but brand-neutral enough for any seed.
function fallbackCopy(brand: Brand): { message: string; headline: string } {
  return {
    message: `Strom und Gas zu teuer? ${brand.name} prüft Deine Verträge und übernimmt den Wechsel für Dich. Kostet nichts, wenn Du nicht sparst.`,
    headline: "Dein Sparservice für Strom und Gas",
  };
}

function copyForAngle(angleId: string, brand: Brand): { message: string; headline: string } {
  const copyAsset = readCollection("assets").find(
    (a) => a.angleId === angleId && a.kind === "ad_copy",
  );
  const payload = copyAsset?.payload as CopyPayload | undefined;
  const variant = payload?.variants?.[payload.chosenIndex ?? 0];
  const fallback = fallbackCopy(brand);
  return {
    message: variant?.primary ?? variant?.hook ?? fallback.message,
    headline: variant?.headline ?? fallback.headline,
  };
}

async function imageBytes(asset: Asset): Promise<Buffer> {
  const payload = asset.payload as StaticPayload;
  if (payload.localPath && fs.existsSync(payload.localPath)) {
    return fs.readFileSync(payload.localPath);
  }
  if (!payload.imageUrl) {
    throw new Error(`Asset ${asset.id}: weder localPath noch imageUrl im Payload`);
  }
  const res = await fetch(payload.imageUrl);
  if (!res.ok) throw new Error(`Bild-Download fehlgeschlagen (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function publishBrand(slug: string): Promise<PublishResult> {
  const { brand, raw } = loadBrandForPublish(slug);
  const run = startRun(slug, "publish");

  try {
    logLine(run.id, AGENT, "prüft Kampagnen-Struktur (Playbook single-cbo-broad) …");
    // Persist runs directly after EVERY create inside the playbook — a later
    // failure must never orphan an already-created campaign.
    const structure = await ensureSingleCboBroad(brand, (b) => persistBrand(b, raw));
    for (const note of structure.notes) {
      logLine(run.id, AGENT, note, note.startsWith("TODO") ? "warn" : "info");
    }
    if (structure.createdCampaign || structure.createdAdSet) {
      logLine(run.id, AGENT, "IDs persistiert (Store + brand.json)");
    }

    const angleIds = new Set(
      readCollection("angles")
        .filter((a) => a.brandSlug === slug)
        .map((a) => a.id),
    );
    const statics = readCollection("assets").filter(
      (a) => a.kind === "static" && angleIds.has(a.angleId),
    );

    const published: PublishedAd[] = [];
    const skipped: { assetId: string; reason: string }[] = [];

    for (const asset of statics) {
      if (asset.metaIds?.adId) {
        skipped.push({ assetId: asset.id, reason: `bereits publisht (Ad ${asset.metaIds.adId})` });
        logLine(run.id, AGENT, `überspringt ${asset.id} — bereits publisht`);
        continue;
      }
      if (asset.status !== "approved") {
        skipped.push({ assetId: asset.id, reason: `Status ${asset.status} (nur approved wird publisht)` });
        continue;
      }

      const adName = buildAdName({ brandSlug: slug, angleId: asset.angleId, assetId: asset.id });
      logLine(run.id, AGENT, `lädt Bild für ${asset.id} hoch …`);
      const hash = await uploadImage(await imageBytes(asset), adName);

      const copy = copyForAngle(asset.angleId, brand);
      logLine(run.id, AGENT, `legt Creative + Ad „${adName}“ an (PAUSED) …`);
      const creative = await createCreative({
        name: adName,
        pageId: brand.meta.pageId,
        imageHash: hash,
        message: copy.message,
        headline: copy.headline,
        link: brand.url,
      });
      const ad = await createAd({
        name: adName,
        adsetId: structure.adsetId,
        creativeId: creative.id,
      });

      asset.metaIds = { creativeId: creative.id, adId: ad.id };
      asset.status = "published";
      upsert("assets", asset);
      published.push({
        assetId: asset.id,
        angleId: asset.angleId,
        adName,
        creativeId: creative.id,
        adId: ad.id,
      });
      logLine(run.id, AGENT, `Ad ${ad.id} angelegt (PAUSED) — Asset ${asset.id} publisht`);
    }

    logLine(
      run.id,
      AGENT,
      `fertig: ${published.length} Ad(s) publisht, ${skipped.length} übersprungen — Aktivierung nur durch Menschen im Ads Manager`,
    );
    endRun(run.id);
    return {
      runId: run.id,
      campaignId: structure.campaignId,
      adsetId: structure.adsetId,
      published,
      skipped,
      notes: structure.notes,
    };
  } catch (err) {
    logLine(
      run.id,
      AGENT,
      `Fehler: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    endRun(run.id);
    throw err;
  }
}
