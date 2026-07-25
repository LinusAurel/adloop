// Stage 3 — Copywriter (SPEC §3): Angle -> outline -> 2 copy variants
// (hook/primary/headline/cta), zod-validated. Guardrails go into the system
// prompt (they are ALSO enforced by the Critic — doubly held is better held).

import { completeStructured } from "../connectors/anthropic.ts";
import { copyDraftSchema, type CopyDraft } from "../schemas.ts";
import { loadBrandDoc, loadSkill } from "../skills.ts";
import type { Angle, Brand } from "../types.ts";

export interface RewriteContext {
  previous: CopyDraft;
  fixes: string[];
}

function buildSystem(brand: Brand): string {
  const parts = [loadSkill("copy")];
  parts.push("## Brand-Guardrails (harte Constraints)");
  parts.push(brand.guardrails.map((g) => `- ${g}`).join("\n"));
  const guardrailsDoc = loadBrandDoc(brand.slug, "guardrails.md");
  if (guardrailsDoc) parts.push(guardrailsDoc);
  return parts.join("\n\n");
}

function buildPrompt(brand: Brand, angle: Angle, rewrite?: RewriteContext): string {
  const parts: string[] = [];
  parts.push(`# Brand: ${brand.name}`);
  parts.push(`Produkt: ${brand.product}`);
  const brandDoc = loadBrandDoc(brand.slug, "brand.md");
  if (brandDoc) parts.push("## Brand-Kontext\n" + brandDoc);

  parts.push(
    "## Freigegebener Angle\n" +
      `- Name: ${angle.name}\n` +
      (angle.category ? `- Kategorie: ${angle.category}\n` : "") +
      (angle.awarenessStage ? `- Awareness-Stufe: ${angle.awarenessStage}\n` : "") +
      (angle.hypothesis ? `- Hypothese: ${angle.hypothesis}\n` : "") +
      `- Segment: ${angle.segment}\n` +
      `- Schmerz: ${angle.pain}\n` +
      `- Mechanismus: ${angle.mechanism}\n` +
      `- Hook-Richtung: ${angle.hookDirection}\n` +
      `- Rationale: ${angle.rationale}`,
  );

  if (rewrite) {
    parts.push(
      "## Rewrite-Auftrag (genau ein Zyklus)\n" +
        "Der Critic hat den letzten Entwurf abgelehnt. Vorherige Varianten:\n" +
        JSON.stringify(rewrite.previous.variants, null, 2) +
        "\n\nPriorisierte Fixes (alle umsetzen):\n" +
        rewrite.fixes.map((f) => `- ${f}`).join("\n"),
    );
  }

  parts.push(
    "## Auftrag\nSchreibe erst das Outline, dann genau 2 Copy-Varianten " +
      "nach dem Skill-Schema. Deutsch, Sprachregeln der Brand strikt einhalten. " +
      "Headline maximal 40 Zeichen, Primary maximal 600 Zeichen.",
  );
  return parts.join("\n\n");
}

export async function writeCopy(
  brand: Brand,
  angle: Angle,
  rewrite?: RewriteContext,
): Promise<CopyDraft> {
  return completeStructured({
    role: "copy",
    system: buildSystem(brand),
    prompt: buildPrompt(brand, angle, rewrite),
    schema: copyDraftSchema,
    schemaName: "copy_draft",
  });
}
