// Curated image models for the Studio picker. Mirror of the adapters in
// engine/connectors/fal.ts — once that file exports FAL_MODELS, this list can
// be replaced by that export (kept separate so the client bundle never pulls
// the Fal server client).

export interface FalModelOption {
  id: string;
  label: string;
  hint: string;
}

export const FAL_MODELS: FalModelOption[] = [
  {
    id: "fal-ai/nano-banana-pro",
    label: "Nano Banana Pro",
    hint: "default, photorealistic visuals",
  },
  {
    id: "fal-ai/gpt-image-2",
    label: "GPT Image 2",
    hint: "stronger text-in-image",
  },
];
