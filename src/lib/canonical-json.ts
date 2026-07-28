import { createHash } from "node:crypto";

/**
 * Canonical JSON form for hashing (Etappe 4 auftrag §0.1).
 *
 * Rules, fixed so the same logical value always hashes identically:
 * - object keys sorted lexicographically
 * - no whitespace between tokens
 * - numbers via JSON (no leading zeros; finite only)
 * - `null` values are omitted (key absent), not serialized as null
 * - arrays preserve element order; null elements inside arrays become absent
 *   slots only via JSON null — array holes are not used; null array elements
 *   are kept as `null` so length stays meaningful
 * - undefined is treated like null (omitted in objects)
 *
 * Documented here because Freigabe hashes and prompt_hash depend on it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number");
    }
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === null || child === undefined) continue;
      out[key] = canonicalize(child);
    }
    return out;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Playbook directory identity (auftrag §0.6): hash over the sorted path list,
 * each entry `path\\0content`, joined with `\\n`.
 */
export function hashPlaybookFiles(files: Readonly<Record<string, string>>): string {
  const parts = Object.keys(files)
    .sort()
    .map((path) => `${path}\0${files[path] ?? ""}`);
  return sha256Text(parts.join("\n"));
}
