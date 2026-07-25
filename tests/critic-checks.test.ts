import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { deterministicChecks } from "../engine/agents/critic.ts";
import type { CopyVariant } from "../engine/schemas.ts";
import type { Brand } from "../engine/types.ts";

// The tests run against the REAL loyft copy rules so brand.json and the
// checks are verified together.
const brand = JSON.parse(
  readFileSync(path.join(process.cwd(), "brands", "loyft", "brand.json"), "utf8"),
) as Brand;
const rules = brand.copyRules;

const cleanVariant: CopyVariant = {
  hook: "Deine Stromrechnung weiß mehr als Du.",
  primary:
    "Schick uns ein Foto Deiner Abrechnung. Wir rechnen ehrlich nach, ob Du zu viel zahlst. Kostet nichts, wenn Du nicht sparst.",
  headline: "Sparpotenzial in 2 Minuten prüfen",
  cta: "Rechnung schicken",
};

test("loyft brand.json enthält copyRules mit Verbots-Mustern", () => {
  assert.ok(rules, "copyRules fehlen in brands/loyft/brand.json");
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
    ["primary", "Unser Wechselservice übernimmt alles.", "Wechselservice"],
    ["primary", "Garantiert günstiger als Dein alter Tarif.", "Garantie"],
    ["primary", "Loyft übernimmt den Wechsel für Dich.", "Großschreibung"],
    ["primary", "Unsere KI vergleicht alle Tarife für Dich.", "KI"],
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
    { ...cleanVariant, primary: "Wir rechnen ehrlich nach, ob du zu viel zahlst." },
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
