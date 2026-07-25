// Stage 5 — Designer (SPEC §3): creative brief from copy + design tokens,
// then one Fal static (4:5 ONLY), stored remotely (Fal URL) and locally under
// data/assets/. Returns the persisted asset row.

import fs from "node:fs";
import path from "node:path";
import { completeStructured } from "../connectors/anthropic.ts";
import { generateStatic } from "../connectors/fal.ts";
import { creativeBriefSchema, type CopyVariant, type CreativeBrief } from "../schemas.ts";
import { loadBrandDoc, loadSkill } from "../skills.ts";
import { appendRunLog, dataDir, newId, upsert } from "../store.ts";
import type { Angle, Asset, Brand } from "../types.ts";

const AGENT = "Designer";

function trimToWords(text: string, maxWords: number): string {
  return text.trim().split(/\s+/).slice(0, maxWords).join(" ");
}

function buildSystem(brand: Brand): string {
  const parts = [loadSkill("creative-brief")];
  parts.push("## Design-Tokens der Brand");
  parts.push(
    Object.entries(brand.designTokens)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join("\n"),
  );
  const designDoc = loadBrandDoc(brand.slug, "design-tokens.md");
  if (designDoc) parts.push(designDoc);
  return parts.join("\n\n");
}

async function createBrief(
  brand: Brand,
  angle: Angle,
  variant: CopyVariant,
): Promise<CreativeBrief> {
  const prompt = [
    "## Angle",
    `- Segment: ${angle.segment}`,
    `- Schmerz: ${angle.pain}`,
    `- Hook-Richtung: ${angle.hookDirection}`,
    "",
    "## Freigegebene Copy",
    JSON.stringify(variant, null, 2),
    "",
    "## Auftrag",
    "Erstelle den Creative Brief nach dem Skill-Schema (imageIdea, textInImage, prompt).",
  ].join("\n");

  const brief = await completeStructured({
    role: "copy",
    system: buildSystem(brand),
    prompt,
    schema: creativeBriefSchema,
    schemaName: "creative_brief",
  });

  // Hard limit from the skill: max 8 words in-image. Mock mode may return a
  // foreign shape, so guard every field before use.
  return {
    imageIdea: brief.imageIdea ?? variant.hook,
    textInImage: trimToWords(brief.textInImage ?? variant.hook, 8),
    prompt:
      brief.prompt ??
      `Editorial static ad photo, calm and precise, 4:5 portrait, text overlay "${trimToWords(variant.hook, 8)}"`,
  };
}

async function downloadImage(url: string, assetId: string): Promise<string> {
  const dir = path.join(dataDir(), "assets");
  fs.mkdirSync(dir, { recursive: true });
  const localPath = path.join(dir, `${assetId}.png`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bild-Download fehlgeschlagen (${res.status})`);
  fs.writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
  return localPath;
}

export async function runDesigner(
  brand: Brand,
  angle: Angle,
  variant: CopyVariant,
  runId: string,
): Promise<Asset> {
  appendRunLog(runId, AGENT, `Creating creative brief for angle "${angle.name}" …`);
  const brief = await createBrief(brand, angle, variant);

  appendRunLog(runId, AGENT, "generiert Static (4:5) via Fal …");
  const imageUrl = await generateStatic({ prompt: brief.prompt, aspectRatio: "4:5" });

  const assetId = newId("ast");
  const localPath = await downloadImage(imageUrl, assetId);
  appendRunLog(runId, AGENT, `Static saved (${path.basename(localPath)})`);

  const asset: Asset = {
    id: assetId,
    angleId: angle.id,
    kind: "static",
    payload: { imageUrl, localPath, brief },
    status: "draft",
  };
  upsert("assets", asset);
  return asset;
}
