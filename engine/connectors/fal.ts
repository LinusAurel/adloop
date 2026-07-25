// Fal connector (SPEC §5): static image generation for the Designer stage.
// One thin adapter per model — model switch is adapter selection, not just an
// env switch, because input contracts differ per model.

import { fal } from "@fal-ai/client";

export interface StaticBrief {
  prompt: string;
  // Designer stage is 4:5 only (SPEC §3, stage 5).
  aspectRatio?: "4:5";
}

interface FalAdapter {
  modelId: string;
  buildInput(brief: StaticBrief): Record<string, unknown>;
  extractImageUrl(data: unknown): string | undefined;
}

type FalImageResult = { images?: Array<{ url?: string }> };

const nanoBananaPro: FalAdapter = {
  modelId: "fal-ai/nano-banana-pro",
  buildInput: (brief) => ({
    prompt: brief.prompt,
    aspect_ratio: brief.aspectRatio ?? "4:5",
  }),
  extractImageUrl: (data) => (data as FalImageResult).images?.[0]?.url,
};

// Fallback model per SPEC §8 (better text-in-image); different input contract.
const gptImage2: FalAdapter = {
  modelId: "fal-ai/gpt-image-2",
  buildInput: (brief) => ({
    prompt: brief.prompt,
    image_size: "1024x1280",
  }),
  extractImageUrl: (data) => (data as FalImageResult).images?.[0]?.url,
};

const adapters: Record<string, FalAdapter> = {
  [nanoBananaPro.modelId]: nanoBananaPro,
  [gptImage2.modelId]: gptImage2,
};

export async function generateStatic(brief: StaticBrief): Promise<string> {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY fehlt (.env)");
  fal.config({ credentials: key });

  const modelId = process.env.FAL_MODEL_ID ?? nanoBananaPro.modelId;
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
