/**
 * Merge website UTM params into a destination URL without destroying click
 * identifiers (fbclid and relatives) that Meta / browsers may already have
 * attached.
 */
const CLICK_ID_KEYS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "ttclid",
  "twclid",
  "li_fat_id",
  "wbraid",
  "gbraid",
]);

export function applyUtmParams(
  baseUrl: string,
  utmParams: string,
): string {
  const url = new URL(baseUrl);
  const preserved = new Map<string, string>();
  for (const key of CLICK_ID_KEYS) {
    const value = url.searchParams.get(key);
    if (value !== null) preserved.set(key, value);
  }

  const raw = utmParams.trim();
  if (raw.length > 0) {
    const query = raw.startsWith("?") ? raw.slice(1) : raw;
    const incoming = new URLSearchParams(query);
    for (const [key, value] of incoming.entries()) {
      if (CLICK_ID_KEYS.has(key.toLowerCase())) continue;
      url.searchParams.set(key, value);
    }
  }

  for (const [key, value] of preserved) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

export function expandNamingTemplate(
  template: string,
  tokens: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    return tokens[key] ?? "";
  });
}

/** Correlation token embedded in Meta object names for reconcile fencing. */
export function formatCorrelatedName(baseName: string, correlation: string): string {
  const trimmed = baseName.trim().slice(0, 180);
  return `${trimmed} [adloop:${correlation}]`;
}

export function correlationFromName(name: string): string | null {
  const match = /\[adloop:([a-f0-9-]+)\]/i.exec(name);
  return match?.[1] ?? null;
}
