// Fal connector (SPEC §5): static image generation for the Designer stage.
// One thin adapter per model — model switch is adapter selection, not just an
// env switch, because input contracts differ per model.

import { fal } from "@fal-ai/client";

export interface StaticBrief {
  prompt: string;
  // Designer stage is 4:5 only (SPEC §3, stage 5).
  aspectRatio?: "4:5";
  // Optional per-request model override (#17); must be a curated FAL_MODELS
  // id. Falls back to FAL_MODEL_ID env, then to the default model.
  modelId?: string;
}

interface FalAdapter {
  modelId: string;
  label: string;
  buildInput(brief: StaticBrief): Record<string, unknown>;
  extractImageUrl(data: unknown): string | undefined;
}

type FalImageResult = { images?: Array<{ url?: string }> };

const firstImageUrl = (data: unknown) => (data as FalImageResult).images?.[0]?.url;

const nanoBananaPro: FalAdapter = {
  modelId: "fal-ai/nano-banana-pro",
  label: "Nano Banana Pro",
  buildInput: (brief) => ({
    prompt: brief.prompt,
    aspect_ratio: brief.aspectRatio ?? "4:5",
  }),
  extractImageUrl: firstImageUrl,
};

// FLUX 1.1 [pro] ultra: free-form aspect_ratio string (4:5 accepted).
const fluxProUltra: FalAdapter = {
  modelId: "fal-ai/flux-pro/v1.1-ultra",
  label: "FLUX 1.1 Pro Ultra",
  buildInput: (brief) => ({
    prompt: brief.prompt,
    aspect_ratio: brief.aspectRatio ?? "4:5",
  }),
  extractImageUrl: firstImageUrl,
};

// Recraft V3: no 4:5 preset — custom image_size keeps the exact ratio.
const recraftV3: FalAdapter = {
  modelId: "fal-ai/recraft/v3/text-to-image",
  label: "Recraft V3",
  buildInput: (brief) => ({
    prompt: brief.prompt,
    image_size: { width: 1024, height: 1280 },
  }),
  extractImageUrl: firstImageUrl,
};

// Ideogram V3 (v2 has no 4:5 ratio): custom image_size for exact 4:5.
const ideogramV3: FalAdapter = {
  modelId: "fal-ai/ideogram/v3",
  label: "Ideogram V3",
  buildInput: (brief) => ({
    prompt: brief.prompt,
    image_size: { width: 1024, height: 1280 },
  }),
  extractImageUrl: firstImageUrl,
};

// Fallback model per SPEC §8 (better text-in-image); different input contract.
// Reachable via FAL_MODEL_ID env, deliberately not part of the curated list.
const gptImage2: FalAdapter = {
  modelId: "fal-ai/gpt-image-2",
  label: "GPT Image 2",
  buildInput: (brief) => ({
    prompt: brief.prompt,
    image_size: "1024x1280",
  }),
  extractImageUrl: firstImageUrl,
};

const adapters: Record<string, FalAdapter> = Object.fromEntries(
  [nanoBananaPro, fluxProUltra, recraftV3, ideogramV3, gptImage2].map((a) => [
    a.modelId,
    a,
  ]),
);

export const DEFAULT_FAL_MODEL_ID = nanoBananaPro.modelId;

// Curated image models for the asset pipeline (#17). IDs verified against
// the live fal.ai OpenAPI schemas on 2026-07-25; every adapter produces 4:5.
export const FAL_MODELS: { id: string; label: string }[] = [
  nanoBananaPro,
  fluxProUltra,
  recraftV3,
  ideogramV3,
].map((a) => ({ id: a.modelId, label: a.label }));

export function isKnownFalModel(id: string): boolean {
  return FAL_MODELS.some((m) => m.id === id);
}

export async function generateStatic(brief: StaticBrief): Promise<string> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY fehlt (.env)");
  fal.config({ credentials: key });

  const modelId = brief.modelId ?? process.env.FAL_MODEL_ID ?? DEFAULT_FAL_MODEL_ID;
  const adapter = adapters[modelId];
  if (!adapter) {
    throw new Error(`Kein Fal-Adapter für Modell ${modelId} (engine/connectors/fal.ts)`);
  }

  const result = await fal.subscribe(adapter.modelId, {
    input: adapter.buildInput(brief),
  });
  const url = adapter.extractImageUrl(result.data);
  if (!url) throw new Error(`Fal-Antwort ohne Bild-URL (Modell ${modelId})`);
  return url;
}
