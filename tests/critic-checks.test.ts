import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { deterministicChecks } from "../engine/agents/critic.ts";
import type { CopyVariant } from "../engine/schemas.ts";
import type { Brand } from "../engine/types.ts";

// The tests run against the committed example brand (brands/creators-demo) so
// brand.json and the checks are verified together — real brand data stays
// local and untracked (#17), so CI clones cannot depend on it.
const brand = JSON.parse(
  readFileSync(path.join(process.cwd(), "brands", "creators-demo", "brand.json"), "utf8"),
) as Brand;
const rules = brand.copyRules;

const cleanVariant: CopyVariant = {
  hook: "Your coffee should taste like its roast date, not its shelf life.",
  primary:
    "Tell us how you drink your coffee. We build a subscription that fits your taste, and you can pause it anytime.",
  headline: "Fresh roasts on subscription",
  cta: "Browse the sampler pack",
};

test("Beispiel-brand.json enthält copyRules mit Verbots-Mustern", () => {
  assert.ok(rules, "copyRules fehlen in brands/creators-demo/brand.json");
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
    ["primary", "Garantiert mehr Leads in 7 Tagen.", "guarantee claim"],
    ["primary", "Die Abzock-Agenturen von nebenan.", "competitor bashing"],
    ["primary", "Ein revolutionärer Game-Changer für dein Business.", "hype without proof"],
    ["cta", "Hier klicken", "weak CTA"],
  ];
  for (const [field, text, label] of cases) {
    const violations = deterministicChecks({ ...cleanVariant, [field]: text }, rules);
    assert.ok(violations.length > 0, `erwarteter Verstoß fehlt: ${label}`);
  }
});

test("Gedankenstrich in kundengerichteter Copy wird erkannt", () => {
  const violations = deterministicChecks(
    { ...cleanVariant, primary: "No effort — we handle everything for you." },
    rules,
  );
  assert.ok(violations.some((v) => v.includes("Gedankenstrich")));
});

test("ohne Regeln laufen nur die generischen Checks", () => {
  const violations = deterministicChecks(
    { ...cleanVariant, primary: "Our AI helps you — guaranteed! ".repeat(3) },
    undefined,
  );
  // Forbidden patterns require brand rules; the generic limit checks pass here.
  assert.deepEqual(violations, []);
});
