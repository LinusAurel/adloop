import assert from "node:assert/strict";
import { test } from "node:test";

import {
  angleListSchema,
  checkAngleDiversity,
  copyDraftSchema,
  creativeBriefSchema,
  criticVerdictSchema,
  type AngleDraft,
} from "../engine/schemas.ts";

function makeAngle(overrides: Partial<AngleDraft> = {}): AngleDraft {
  return {
    name: "Grundversorgungs-Falle",
    segment: "Nicht-Wechsler in der Grundversorgung",
    pain: "Zahlt seit Jahren still zu viel, ohne es zu merken",
    mechanism: "Erst-Check per Rechnung deckt das Delta konkret auf",
    hookDirection: "Zahlen-Schock mit sofortiger Auflösung",
    expectedCpl: 14,
    rationale: "Rund 23 Prozent der Haushalte stecken in der Grundversorgung (BNetzA).",
    ...overrides,
  };
}

test("angleListSchema akzeptiert einen validen Satz", () => {
  const parsed = angleListSchema.parse({ angles: [makeAngle()] });
  assert.equal(parsed.angles.length, 1);
});

test("angleListSchema lehnt fehlende Felder ab", () => {
  const broken = { angles: [{ name: "Zu wenig" }] };
  assert.throws(() => angleListSchema.parse(broken));
});

test("angleListSchema lehnt expectedCpl außerhalb des Rahmens ab", () => {
  assert.throws(() => angleListSchema.parse({ angles: [makeAngle({ expectedCpl: 0 })] }));
});

test("checkAngleDiversity meldet identische Felder paarweise", () => {
  const a = makeAngle();
  const b = makeAngle({ name: "Kopie", segment: a.segment });
  const violations = checkAngleDiversity([a, b]);
  assert.ok(violations.some((v) => v.includes("segment")));
});

test("checkAngleDiversity ist bei diversen Angles leer", () => {
  const a = makeAngle();
  const b = makeAngle({
    name: "Nie-wieder-kümmern",
    segment: "Bequeme Ex-Wechsler",
    pain: "Hat einmal gewechselt und will das nie wieder selbst machen",
    hookDirection: "Entlastungs-Versprechen statt Spar-Claim",
  });
  assert.deepEqual(checkAngleDiversity([a, b]), []);
});

test("copyDraftSchema verlangt Outline und genau 2 Varianten", () => {
  const variant = {
    hook: "Deine Stromrechnung weiß mehr als Du.",
    primary:
      "Schick uns ein Foto Deiner Abrechnung. Wir rechnen ehrlich nach, ob Du zu viel zahlst. Kostet nichts, wenn Du nicht sparst.",
    headline: "Sparpotenzial in 2 Minuten prüfen",
    cta: "Rechnung schicken",
  };
  const valid = {
    outline: "Awareness: problem-aware. Hook: Rechnung als Beweis. CTA: Rechnung schicken.",
    variants: [variant, { ...variant, hook: "Du zahlst still zu viel für Strom." }],
  };
  assert.equal(copyDraftSchema.parse(valid).variants.length, 2);
  assert.throws(() => copyDraftSchema.parse({ ...valid, variants: [variant] }));
  assert.throws(() => copyDraftSchema.parse({ variants: valid.variants }));
});

test("criticVerdictSchema begrenzt den Score auf 1-10", () => {
  const valid = { score: 7, notes: ["Hook trägt"], fixes: [] };
  assert.equal(criticVerdictSchema.parse(valid).score, 7);
  assert.throws(() => criticVerdictSchema.parse({ ...valid, score: 11 }));
  assert.throws(() => criticVerdictSchema.parse({ ...valid, notes: [] }));
});

test("creativeBriefSchema verlangt einen ausformulierten Prompt", () => {
  const valid = {
    imageIdea: "Stromrechnung auf Küchentisch, harter Lichtkontrast",
    textInImage: "Du zahlst zu viel",
    prompt:
      "Editorial still life photo of a German electricity bill on a kitchen table, calm palette, 4:5",
  };
  assert.ok(creativeBriefSchema.parse(valid).prompt.length > 40);
  assert.throws(() => creativeBriefSchema.parse({ ...valid, prompt: "kurz" }));
});
