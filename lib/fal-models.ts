// Curated image models for the Studio picker. Mirror of the adapters in
// engine/connectors/fal.ts — once that file exports FAL_MODELS, this list can
// be replaced by that export (kept separate so the client bundle never pulls
// the Fal server client). IDs must stay identical to the engine list: the
// generate route validates against isKnownFalModel() and rejects others (400).

export interface FalModelOption {
  id: string;
  label: string;
  hint: string;
}

export const FAL_MODELS: FalModelOption[] = [
  {
    id: "fal-ai/nano-banana-pro",
    label: "Nano Banana Pro",
    hint: "default, photorealistic",
  },
  {
    id: "fal-ai/flux-pro/v1.1-ultra",
    label: "FLUX Pro 1.1 Ultra",
    hint: "premium quality",
  },
  {
    id: "fal-ai/recraft/v3/text-to-image",
    label: "Recraft V3",
    hint: "design and brand style",
  },
  {
    id: "fal-ai/ideogram/v3",
    label: "Ideogram V3",
    hint: "strong text rendering",
  },
];
