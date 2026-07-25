// Per-brand accent colour: taken from the brand's own design tokens when the
// Scout captured one, otherwise a stable pick from a muted fallback palette.
// The accent is context signal (avatar, wordmark, active nav icon) — never
// large surfaces. It must read on the dark ink ground (DESIGN.md palette).

const FALLBACK_PALETTE = [
  "#4FB8A2", // sea green
  "#7C9BE8", // periwinkle
  "#D08B4C", // copper
  "#B58BE8", // lilac
  "#5EC46B", // leaf
  "#E88BA0", // rose
];

function looksLikeHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Visible on the ink ground, but not blinding: mid to bright tones only.
function readsOnInk(hex: string): boolean {
  const l = luminance(hex);
  return l >= 0.28 && l <= 0.92;
}

export function accentForBrand(
  slug: string,
  designTokens?: Record<string, string>,
): string {
  for (const key of ["primary", "accent", "mint", "ink", "inkDark"]) {
    const value = designTokens?.[key];
    if (looksLikeHex(value) && readsOnInk(value.trim())) return value.trim();
  }
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

// Legible text colour on top of the accent (avatar initial).
export function onAccent(hex: string): string {
  return luminance(hex) > 0.55 ? "#04120a" : "#e9eff1";
}
