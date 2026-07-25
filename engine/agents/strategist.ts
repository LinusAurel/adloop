// Stage 2 — Strategist (SPEC §3): Brand + Evidence -> 5 diverse angles with
// rationale and expectedCpl. Diversity violations trigger exactly one rewrite;
// a second violation is logged as a warning but does not block the demo flow.

import { completeStructured, isMockMode, mockModeHint } from "../connectors/anthropic.ts";
import {
  angleListSchema,
  checkAngleDiversity,
  type AngleDraft,
  type AngleList,
} from "../schemas.ts";
import { loadBrandDoc, loadSkill } from "../skills.ts";
import {
  appendRunLog,
  createRun,
  ensureBrandSeed,
  finishRun,
  newId,
  readCollection,
  resolveCampaignTarget,
  upsert,
} from "../store.ts";
import type { Angle, Brand, Evidence, Run } from "../types.ts";

const ANGLE_COUNT = 5;
const AGENT = "Strategist";

function buildSystem(brand: Brand): string {
  const parts = [loadSkill("angles")];
  parts.push("## Brand-Guardrails (harte Constraints)");
  parts.push(brand.guardrails.map((g) => `- ${g}`).join("\n"));
  const guardrailsDoc = loadBrandDoc(brand.slug, "guardrails.md");
  if (guardrailsDoc) parts.push(guardrailsDoc);
  return parts.join("\n\n");
}

function buildPrompt(brand: Brand, evidence: Evidence[], existing: Angle[]): string {
  const parts: string[] = [];
  parts.push(`# Brand: ${brand.name} (${brand.url})`);
  parts.push(`Produkt: ${brand.product}`);
  // Campaign-level target first, brand.targetCpa as fallback (#17).
  const target = resolveCampaignTarget(brand);
  parts.push(
    target != null
      ? `Ziel-${target.metric}: ${target.value} € (Conversion-Goal: ${brand.conversionGoal})`
      : `Ziel-CPA: noch nicht gesetzt — schätze expectedCpl marktüblich konservativ (Conversion-Goal: ${brand.conversionGoal})`,
  );

  const brandDoc = loadBrandDoc(brand.slug, "brand.md");
  if (brandDoc) parts.push("## Brand-Kontext\n" + brandDoc);
  const zielDoc = loadBrandDoc(brand.slug, "zielfunktion.md");
  if (zielDoc) parts.push("## Zielfunktion\n" + zielDoc);

  if (evidence.length > 0) {
    parts.push(
      "## Evidence aus dem Store\n" +
        evidence
          .map((e) => `- [${e.tag}] (${e.source}) ${e.text}`)
          .join("\n"),
    );
  }
  if (existing.length > 0) {
    parts.push(
      "## Bereits vorhandene Angles (KEINE Duplikate dazu erzeugen)\n" +
        existing
          .map((a) => `- ${a.name} (${a.status}): ${a.segment} / ${a.hookDirection}`)
          .join("\n"),
    );
  }

  parts.push(
    `## Auftrag\nErzeuge genau ${ANGLE_COUNT} diverse Angles nach dem Skill-Schema. ` +
      "Beachte die Diversitäts-Pflicht (segment, pain, hookDirection paarweise unterschiedlich) " +
      "und die CPL-Ziele der Brand für expectedCpl.",
  );
  return parts.join("\n\n");
}

// Brand isolation (#12): id, brandSlug and status are OWNED by this function —
// the spread comes first so no draft field (e.g. a stray brandSlug from an
// unvalidated mock payload) can ever override them.
export function draftsToAngles(drafts: AngleDraft[], slug: string): Angle[] {
  return drafts.map((d) => ({
    ...d,
    id: newId("ang"),
    brandSlug: slug,
    status: "draft" as const,
  }));
}

// opts.run: pre-created by the route so it can answer 202 + runId before
// the LLM work happens (#7); without it the agent creates its own run.
export async function runStrategist(
  slug: string,
  opts: { run?: Run } = {},
): Promise<{ runId: string; angles: Angle[] }> {
  const brand = ensureBrandSeed(slug);
  if (!brand) throw new Error("brand_not_found");

  const run = opts.run ?? createRun(slug, "strategist");
  try {
    // A mock run must be recognizable as such in the UI, not only on stdout —
    // silent mock output caused fake angles under a real brand (#12).
    if (isMockMode()) appendRunLog(run.id, AGENT, mockModeHint(), "warn");
    const evidence = readCollection("evidence").filter((e) => e.brandSlug === slug);
    const existing = readCollection("angles").filter((a) => a.brandSlug === slug);
    appendRunLog(
      run.id,
      AGENT,
      `liest Brand-Kontext (${evidence.length} Evidence-Einträge, ${existing.length} bestehende Angles)`,
    );

    const system = buildSystem(brand);
    const prompt = buildPrompt(brand, evidence, existing);
    appendRunLog(run.id, AGENT, `erzeugt ${ANGLE_COUNT} diverse Angles …`);

    let draft: AngleList = await completeStructured({
      role: "strategist",
      system,
      prompt,
      schema: angleListSchema,
      schemaName: "angle_list",
    });

    let violations = checkAngleDiversity(draft.angles);
    if (violations.length > 0) {
      appendRunLog(
        run.id,
        AGENT,
        `Diversitäts-Verstöße erkannt (${violations.length}) — ein Rewrite-Zyklus`,
        "warn",
      );
      draft = await completeStructured({
        role: "strategist",
        system,
        prompt:
          prompt +
          "\n\n## Rewrite-Auftrag\nDein letzter Entwurf verletzt die Diversitäts-Pflicht:\n" +
          violations.map((v) => `- ${v}`).join("\n") +
          "\nErzeuge den kompletten Satz neu mit klar unterscheidbaren Konzepten.",
        schema: angleListSchema,
        schemaName: "angle_list",
      });
      violations = checkAngleDiversity(draft.angles);
      if (violations.length > 0) {
        appendRunLog(
          run.id,
          AGENT,
          `Diversität weiterhin verletzt (${violations.length}) — Angles werden trotzdem gespeichert`,
          "warn",
        );
      }
    }

    // Deterministic duplicate guard: identical names for the same brand are
    // never inserted twice (mock mode reproduces the same drafts every run).
    const existingNames = new Set(existing.map((a) => a.name.trim().toLowerCase()));
    const freshDrafts = draft.angles.filter(
      (d) => !existingNames.has(d.name.trim().toLowerCase()),
    );
    const skipped = draft.angles.length - freshDrafts.length;
    if (skipped > 0) {
      appendRunLog(
        run.id,
        AGENT,
        `${skipped} Angle(s) übersprungen — Name existiert für diese Brand bereits`,
        "warn",
      );
    }

    const angles = draftsToAngles(freshDrafts, slug);
    for (const angle of angles) {
      upsert("angles", angle);
      appendRunLog(
        run.id,
        AGENT,
        `Angle „${angle.name}“ (${angle.segment}) angelegt — erwarteter CPL ${angle.expectedCpl} €`,
      );
    }

    appendRunLog(run.id, AGENT, `fertig: ${angles.length} Angles im Board`);
    finishRun(run.id);
    return { runId: run.id, angles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(run.id, AGENT, `Fehler: ${message}`, "error");
    finishRun(run.id, message);
    throw err;
  }
}
