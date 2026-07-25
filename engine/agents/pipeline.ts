// Asset pipeline (SPEC §2): POST /api/angles/:id/assets/generate wires
// Copywriter -> Critic -> Designer sequentially. Best-variant score < 7
// triggers exactly ONE automatic rewrite cycle, then the best variant goes to
// the Designer. Produces an AssetPair: one ad_copy asset + one static asset.

import { writeCopy } from "./copywriter.ts";
import { critiqueVariant, type CriticResult } from "./critic.ts";
import { runDesigner } from "./designer.ts";
import type { CopyDraft } from "../schemas.ts";
import {
  appendRunLog,
  createRun,
  ensureBrandSeed,
  finishRun,
  newId,
  readCollection,
  upsert,
} from "../store.ts";
import type { Angle, Asset, Brand, Run } from "../types.ts";

export const REWRITE_THRESHOLD = 7;

async function critiqueAll(
  brand: Brand,
  angle: Angle,
  draft: CopyDraft,
  runId: string,
): Promise<CriticResult[]> {
  const results: CriticResult[] = [];
  for (const [index, variant] of draft.variants.entries()) {
    const result = await critiqueVariant(brand, angle, variant);
    const hardNote =
      result.deterministicViolations.length > 0
        ? `, ${result.deterministicViolations.length} harte Verstöße`
        : "";
    appendRunLog(
      runId,
      "Critic",
      `Variante ${index + 1}: Score ${result.score}/10${hardNote}`,
    );
    results.push(result);
  }
  return results;
}

function bestIndex(results: CriticResult[]): number {
  return results.reduce(
    (best, r, i) => (r.score > results[best].score ? i : best),
    0,
  );
}

// Regenerating never replaces an asset: each run appends a NEW asset with the
// next version number for (angleId, kind); previous versions stay untouched
// in the store as history (#16).
function nextVersion(angleId: string, kind: Asset["kind"]): number {
  const existing = readCollection("assets").filter(
    (a) => a.angleId === angleId && a.kind === kind,
  );
  return existing.reduce((max, a) => Math.max(max, a.version ?? 1), 0) + 1;
}

// opts.run: pre-created by the route so it can answer 202 + runId before
// the pipeline work happens (#7); without it the agent creates its own run.
// opts.model: optional curated Fal model id for the Designer (#17).
export async function generateAssetPair(
  angleId: string,
  opts: { run?: Run; model?: string } = {},
): Promise<{ runId: string; copyAsset: Asset; staticAsset: Asset }> {
  const angle = readCollection("angles").find((a) => a.id === angleId);
  if (!angle) throw new Error("angle_not_found");
  const brand = ensureBrandSeed(angle.brandSlug);
  if (!brand) throw new Error("brand_not_found");

  const run = opts.run ?? createRun(brand.slug, "assets", angle.id);
  try {
    appendRunLog(
      run.id,
      "Copywriter",
      `schreibt Outline und 2 Varianten für Angle „${angle.name}“ …`,
    );
    let draft = await writeCopy(brand, angle);
    let results = await critiqueAll(brand, angle, draft, run.id);
    let rewriteHappened = false;

    let chosen = bestIndex(results);
    if (results[chosen].score < REWRITE_THRESHOLD) {
      // SPEC §3 stage 4: score < 7 triggers exactly one rewrite cycle.
      const fixes = [...new Set(results.flatMap((r) => r.fixes))];
      appendRunLog(
        run.id,
        "Critic",
        `bester Score ${results[chosen].score} < ${REWRITE_THRESHOLD} — genau ein Rewrite-Zyklus`,
      );
      appendRunLog(run.id, "Copywriter", "überarbeitet beide Varianten nach Critic-Fixes …");
      draft = await writeCopy(brand, angle, { previous: draft, fixes });
      results = await critiqueAll(brand, angle, draft, run.id);
      chosen = bestIndex(results);
      rewriteHappened = true;
    }

    const best = results[chosen];
    const copyAsset: Asset = {
      id: newId("ast"),
      angleId: angle.id,
      kind: "ad_copy",
      version: nextVersion(angle.id, "ad_copy"),
      payload: {
        outline: draft.outline,
        variants: draft.variants,
        chosenIndex: chosen,
        rewriteHappened,
        critic: results.map((r) => ({
          score: r.score,
          llmScore: r.llmScore,
          notes: r.notes,
          fixes: r.fixes,
          deterministicViolations: r.deterministicViolations,
        })),
      },
      criticScore: best.score,
      criticNotes: [...best.notes, ...best.fixes].join("\n"),
      status: "draft",
    };
    upsert("assets", copyAsset);
    appendRunLog(
      run.id,
      "Critic",
      `Variante ${chosen + 1} gewählt (Score ${best.score}/10) — Copy-Asset gespeichert`,
    );

    // Versioning happens here (not in the Designer) so ALL regenerate paths
    // share one rule: new row, version+1, previous asset kept as history.
    // Computed BEFORE the Designer upserts the new row, so the fresh asset
    // does not count itself.
    const staticVersion = nextVersion(angle.id, "static");
    const staticAsset = await runDesigner(
      brand,
      angle,
      draft.variants[chosen],
      run.id,
      opts.model,
    );
    staticAsset.version = staticVersion;
    upsert("assets", staticAsset);
    appendRunLog(run.id, "Designer", "AssetPair vollständig — bereit fürs Studio");
    finishRun(run.id);
    return { runId: run.id, copyAsset, staticAsset };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(run.id, "Pipeline", `Fehler: ${message}`, "error");
    finishRun(run.id, message);
    throw err;
  }
}
