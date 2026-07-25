// Zod schemas for structured LLM outputs (SPEC §3: stages 2-4 are
// zod-validated). Structural limits are deliberately lenient here — hard
// character limits are enforced by the Critic's deterministic checks, so a
// slightly-too-long headline triggers a rewrite instead of a pipeline crash.

import { z } from "zod";

export const angleDraftSchema = z.object({
  name: z.string().min(3).max(80),
  segment: z.string().min(5).max(300),
  pain: z.string().min(10).max(400),
  mechanism: z.string().min(10).max(400),
  hookDirection: z.string().min(5).max(300),
  expectedCpl: z.number().min(1).max(200),
  rationale: z.string().min(20).max(800),
});
export type AngleDraft = z.infer<typeof angleDraftSchema>;

export const angleListSchema = z.object({
  angles: z.array(angleDraftSchema).min(1).max(8),
});
export type AngleList = z.infer<typeof angleListSchema>;

// Diversity is a schema-level requirement (SPEC §1): segment, pain and
// hookDirection must be pairwise distinguishable. Returns human-readable
// violations; empty array means the set is diverse enough.
export function checkAngleDiversity(angles: AngleDraft[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const violations: string[] = [];
  for (let i = 0; i < angles.length; i += 1) {
    for (let j = i + 1; j < angles.length; j += 1) {
      const a = angles[i];
      const b = angles[j];
      for (const field of ["segment", "pain", "hookDirection"] as const) {
        if (norm(a[field]) === norm(b[field])) {
          violations.push(
            `Angles „${a.name}“ und „${b.name}“ haben identisches Feld ${field}`,
          );
        }
      }
    }
  }
  return violations;
}

export const copyVariantSchema = z.object({
  hook: z.string().min(5).max(300),
  primary: z.string().min(50).max(1200),
  headline: z.string().min(5).max(120),
  cta: z.string().min(3).max(60),
});
export type CopyVariant = z.infer<typeof copyVariantSchema>;

export const copyDraftSchema = z.object({
  outline: z.string().min(20).max(2000),
  variants: z.array(copyVariantSchema).min(2).max(2),
});
export type CopyDraft = z.infer<typeof copyDraftSchema>;

export const criticVerdictSchema = z.object({
  score: z.number().min(1).max(10),
  notes: z.array(z.string()).min(1).max(12),
  fixes: z.array(z.string()).max(12),
});
export type CriticVerdict = z.infer<typeof criticVerdictSchema>;

export const creativeBriefSchema = z.object({
  imageIdea: z.string().min(10).max(600),
  // Max 8 words per skill; kept lenient here, the Designer trims if needed.
  textInImage: z.string().max(120),
  prompt: z.string().min(40).max(3000),
});
export type CreativeBrief = z.infer<typeof creativeBriefSchema>;

// Stage 1 — Scout (SPEC §3): Unified Research Document. The awareness
// distribution is ALWAYS a hypothesis (no first-party data at onboarding);
// evidence rows created from it carry the tag "hypothesis".
export const scoutSegmentSchema = z.object({
  name: z.string().min(3).max(120),
  psychographics: z.string().min(20).max(600),
  pains: z.array(z.string().min(5).max(300)).min(1).max(6),
});
export type ScoutSegment = z.infer<typeof scoutSegmentSchema>;

export const awarenessDistributionSchema = z.object({
  unaware: z.number().min(0).max(100),
  problemAware: z.number().min(0).max(100),
  solutionAware: z.number().min(0).max(100),
  productAware: z.number().min(0).max(100),
  mostAware: z.number().min(0).max(100),
});
export type AwarenessDistribution = z.infer<typeof awarenessDistributionSchema>;

export const scoutResearchSchema = z.object({
  productSummary: z.string().min(20).max(800),
  valueProposition: z.string().min(10).max(600),
  pricingModel: z.string().min(3).max(400),
  tonality: z.string().min(3).max(400),
  segments: z.array(scoutSegmentSchema).min(2).max(6),
  awarenessDistribution: awarenessDistributionSchema,
  awarenessRationale: z.string().min(20).max(800),
  competitorNotes: z.array(z.string().min(10).max(400)).max(8),
  vocPhrases: z.array(z.string().min(3).max(300)).max(12),
  objections: z.array(z.string().min(5).max(300)).max(8),
});
export type ScoutResearch = z.infer<typeof scoutResearchSchema>;
