import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { deterministicChecks } from "../engine/agents/critic.ts";
import type { CopyVariant } from "../engine/schemas.ts";
import type { Brand } from "../engine/types.ts";

// The tests run against the committed example brand (brands/_example) so
// brand.json and the checks are verified together — real brand data stays
// local and untracked (#17), so CI clones cannot depend on it.
const brand = JSON.parse(
  readFileSync(path.join(process.cwd(), "brands", "_example", "brand.json"), "utf8"),
) as Brand;
const rules = brand.copyRules;

const cleanVariant: CopyVariant = {
  hook: "Dein Kaffee schmeckt nach Röstdatum, nicht nach Regal.",
  primary:
    "Sag uns, wie Du Deinen Kaffee trinkst. Wir stellen Dir ein Abo zusammen, das zu Dir passt. Pausieren kannst Du jederzeit.",
  headline: "Frisch geröstet ins Abo",
  cta: "Probierpaket ansehen",
};

test("Beispiel-brand.json enthält copyRules mit Verbots-Mustern", () => {
  assert.ok(rules, "copyRules fehlen in brands/_example/brand.json");
  assert.ok(rules.forbiddenPatterns.length >= 5);
});

test("regelkonforme Variante hat keine Verstöße", () => {
  assert.deepEqual(deterministicChecks(cleanVariant, rules), []);
});

test("Headline über 40 Zeichen wird erkannt", () => {
  const violations = deterministicChecks(
    { ...cleanVariant, headline: "x".repeat(41) },
    rules,
  );
  assert.ok(violations.some((v) => v.includes("Headline")));
});

test("Primary Text über 600 Zeichen wird erkannt", () => {
  const violations = deterministicChecks(
    { ...cleanVariant, primary: "Wort ".repeat(150) },
    rules,
  );
  assert.ok(violations.some((v) => v.includes("Primary")));
});

test("leerer CTA wird erkannt", () => {
  const violations = deterministicChecks({ ...cleanVariant, cta: "   " }, rules);
  assert.ok(violations.some((v) => v.includes("CTA")));
});

test("verbotene Begriffe werden per Regex erkannt", () => {
  const cases: Array<[keyof CopyVariant, string, string]> = [
    ["primary", "Garantiert besser als jeder Kaffee aus dem Regal.", "Garantie"],
    ["primary", "Billigkaffee war gestern.", "Wettbewerber-Bashing"],
    ["cta", "Hier klicken", "Hier klicken"],
  ];
  for (const [field, text, label] of cases) {
    const violations = deterministicChecks({ ...cleanVariant, [field]: text }, rules);
    assert.ok(violations.length > 0, `erwarteter Verstoß fehlt: ${label}`);
  }
});

test("Gedankenstrich in kundengerichteter Copy wird erkannt", () => {
  const violations = deterministicChecks(
    { ...cleanVariant, primary: "Kein Aufwand — wir übernehmen alles für Dich." },
    rules,
  );
  assert.ok(violations.some((v) => v.includes("Gedankenstrich")));
});

test("kleingeschriebenes Du/Dein wird erkannt", () => {
  const violations = deterministicChecks(
    { ...cleanVariant, primary: "Wir rösten frisch, und du bestellst nie wieder Regalware." },
    rules,
  );
  assert.ok(violations.some((v) => v.includes("großgeschrieben")));
});

test("ohne Regeln laufen nur die generischen Checks", () => {
  const violations = deterministicChecks(
    { ...cleanVariant, primary: "Unsere KI hilft dir — garantiert! ".repeat(3) },
    undefined,
  );
  // Forbidden patterns require brand rules; the generic limit checks pass here.
  assert.deepEqual(violations, []);
});
