// Stage 4 — Critic (SPEC §3): deterministic checks BEFORE the LLM (character
// limits, forbidden words from brand copy rules, CTA present), then an LLM
// rubric score 1-10. Deterministic violations cap the score at 4 — the LLM
// supplements the hard checks, it never overrules them.

import { completeStructured } from "../connectors/anthropic.ts";
import { criticVerdictSchema, type CopyVariant } from "../schemas.ts";
import { loadBrandDoc, loadSkill } from "../skills.ts";
import type { Angle, Brand, CopyRules } from "../types.ts";

export const MAX_HEADLINE_CHARS = 40;
export const MAX_PRIMARY_CHARS = 600;
// Any deterministic violation caps the final score below the rewrite
// threshold, so hard rule breaks always trigger the rewrite cycle.
export const DETERMINISTIC_SCORE_CAP = 4;

export function deterministicChecks(
  variant: CopyVariant,
  rules?: CopyRules,
): string[] {
  const violations: string[] = [];

  if (variant.headline.length > MAX_HEADLINE_CHARS) {
    violations.push(
      `Headline hat ${variant.headline.length} Zeichen (Limit ${MAX_HEADLINE_CHARS})`,
    );
  }
  if (variant.primary.length > MAX_PRIMARY_CHARS) {
    violations.push(
      `Primary Text hat ${variant.primary.length} Zeichen (Limit ${MAX_PRIMARY_CHARS})`,
    );
  }
  if (variant.cta.trim().length === 0) {
    violations.push("CTA fehlt");
  }

  const fullText = [variant.hook, variant.primary, variant.headline, variant.cta].join(
    "\n",
  );
  for (const rule of rules?.forbiddenPatterns ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, rule.flags ?? "");
    } catch {
      violations.push(`Ungültiges Verbots-Muster in brand.json: ${rule.pattern}`);
      continue;
    }
    const match = fullText.match(re);
    if (match) {
      violations.push(`Verbotenes Muster „${match[0]}“: ${rule.reason}`);
    }
  }
  return violations;
}

export interface CriticResult {
  score: number;
  llmScore: number;
  notes: string[];
  fixes: string[];
  deterministicViolations: string[];
}

function buildSystem(brand: Brand): string {
  const parts = [loadSkill("critic")];
  parts.push("## Brand-Guardrails (harte Constraints)");
  parts.push(brand.guardrails.map((g) => `- ${g}`).join("\n"));
  const guardrailsDoc = loadBrandDoc(brand.slug, "guardrails.md");
  if (guardrailsDoc) parts.push(guardrailsDoc);
  return parts.join("\n\n");
}

export async function critiqueVariant(
  brand: Brand,
  angle: Angle,
  variant: CopyVariant,
): Promise<CriticResult> {
  const deterministic = deterministicChecks(variant, brand.copyRules);

  const prompt = [
    "## Angle",
    `- Segment: ${angle.segment}`,
    `- Schmerz: ${angle.pain}`,
    `- Mechanismus: ${angle.mechanism}`,
    `- Hook-Richtung: ${angle.hookDirection}`,
    // Message-match criterion needs the falsifiable hypothesis when present.
    ...(angle.hypothesis ? [`- Hypothese: ${angle.hypothesis}`] : []),
    ...(angle.awarenessStage ? [`- Awareness-Stufe: ${angle.awarenessStage}`] : []),
    "",
    "## Zu prüfende Copy-Variante",
    JSON.stringify(variant, null, 2),
    "",
    deterministic.length > 0
      ? "## Befunde der deterministischen Checks (Fakten, in fixes aufnehmen)\n" +
        deterministic.map((v) => `- ${v}`).join("\n")
      : "## Deterministische Checks: bestanden",
    "",
    "## Auftrag",
    "Bewerte die Variante entlang der Rubrik. Gib score, notes und priorisierte fixes.",
  ].join("\n");

  const verdict = await completeStructured({
    role: "critic",
    system: buildSystem(brand),
    prompt,
    schema: criticVerdictSchema,
    schemaName: "critic_verdict",
  });

  const llmScore = Math.max(1, Math.min(10, Math.round(verdict.score)));
  const score =
    deterministic.length > 0 ? Math.min(llmScore, DETERMINISTIC_SCORE_CAP) : llmScore;

  return {
    score,
    llmScore,
    notes: verdict.notes ?? [],
    fixes: [...deterministic, ...(verdict.fixes ?? [])],
    deterministicViolations: deterministic,
  };
}
