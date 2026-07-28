import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import de from "../messages/de.json";
import en from "../messages/en.json";
import { MESSAGE_KEYS } from "@/i18n/keys";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe("i18n catalogues", () => {
  it("de.json and en.json have identical key sets", () => {
    expect(flattenKeys(de as Record<string, unknown>)).toEqual(
      flattenKeys(en as Record<string, unknown>),
    );
  });

  it("registry keys exist in both catalogues", () => {
    const deKeys = new Set(flattenKeys(de as Record<string, unknown>));
    const enKeys = new Set(flattenKeys(en as Record<string, unknown>));
    for (const key of MESSAGE_KEYS) {
      expect(deKeys.has(key), `missing in de: ${key}`).toBe(true);
      expect(enKeys.has(key), `missing in en: ${key}`).toBe(true);
    }
  });

  it("every static t(\"…\") key used in src is registered", () => {
    const root = join(__dirname, "..", "src");
    const files: string[] = [];
    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    }
    walk(root);

    const used = new Set<string>();
    const tCall = /\bt\(\s*["']([a-z0-9_.]+)["']/g;
    const nested = /useTranslations\(\s*["']([a-z0-9_]+)["']\s*\)/g;

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const namespaces: string[] = [];
      let match: RegExpExecArray | null;
      nested.lastIndex = 0;
      while ((match = nested.exec(text))) {
        namespaces.push(match[1]!);
      }
      tCall.lastIndex = 0;
      while ((match = tCall.exec(text))) {
        const key = match[1]!;
        if (key.includes(".")) {
          used.add(key);
        } else {
          for (const ns of namespaces) {
            used.add(`${ns}.${key}`);
          }
        }
      }
    }

    const registry = new Set<string>(MESSAGE_KEYS);
    for (const key of used) {
      expect(registry.has(key), `unregistered message key: ${key}`).toBe(true);
    }
  });

  it("tsx files that use useTranslations do not embed visible prose outside t(...)", () => {
    // Catches hard-coded labels like "save override" that never call t().
    // Scoped to files that already participate in i18n (useTranslations) so
    // legacy etappe-2/3 pages without catalogues are not false positives.
    const root = join(__dirname, "..", "src");
    const files: string[] = [];
    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".tsx")) files.push(path);
      }
    }
    walk(root);

    const offenders: string[] = [];
    // Single-line JSX text nodes with a space (user-facing phrase).
    const betweenTags = />\s*([A-Za-zÄÖÜäöüß][^<{\n]*\s[^<{\n]*?)\s*</g;

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("useTranslations")) continue;

      const scrubbed = text
        .replace(/\bt\(\s*["'][^"']+["'][^)]*\)/g, "t(/*ok*/)")
        .replace(/\{t\([^)]*\)\}/g, "{/*t*/}");

      let match: RegExpExecArray | null;
      betweenTags.lastIndex = 0;
      while ((match = betweenTags.exec(scrubbed))) {
        const phrase = match[1]!.trim();
        if (!phrase || phrase.length < 3) continue;
        if (/^[A-Za-z0-9_./:-]+$/.test(phrase)) continue;
        if (/[{}`=()]/.test(phrase)) continue;
        offenders.push(`${relative(join(__dirname, ".."), file)}: "${phrase}"`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("design constraints", () => {
  it("no hex colour literals outside theme/*.css", () => {
    const root = join(__dirname, "..", "src");
    const offenders: string[] = [];
    const hex = /#[0-9a-fA-F]{3,8}\b/;

    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx|css)$/.test(name)) continue;
        const rel = relative(root, path);
        if (rel.startsWith(`theme${sep}`) || rel.startsWith("theme/")) continue;
        const text = readFileSync(path, "utf8");
        if (hex.test(text)) offenders.push(rel);
      }
    }
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("metrics number cells use --font-data via .data", () => {
    const metricsPage = readFileSync(
      join(__dirname, "..", "src", "app", "metrics", "page.tsx"),
      "utf8",
    );
    expect(
      metricsPage.includes('className="data"') || metricsPage.includes("var(--font-data)"),
    ).toBe(true);
  });
});
