// Per-brand accent colour: taken from the brand's own design tokens when the
// Scout captured one, otherwise a stable pick from a muted fallback palette.
// The accent is context signal (avatar, active nav, small details) — never
// large surfaces.

const FALLBACK_PALETTE = [
  "#31646e", // petrol
  "#4a5d8f", // slate blue
  "#7a4a3f", // clay
  "#3b6e52", // forest
  "#6b4e7c", // plum
  "#8a6a2f", // ochre
];

function looksLikeHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

export function accentForBrand(
  slug: string,
  designTokens?: Record<string, string>,
): string {
  // Prefer an explicit dark brand tone; loud tones (neon) stay out of the UI.
  for (const key of ["ink", "inkDark", "accent", "primary"]) {
    const value = designTokens?.[key];
    if (looksLikeHex(value)) return value.trim();
  }
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}
