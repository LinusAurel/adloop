import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { generateAssetPair } from "@/engine/agents/pipeline";
import { FAL_MODELS, isKnownFalModel } from "@/engine/connectors/fal";
import {
  createRun,
  ensureBrandSeed,
  finishRun,
  readCollection,
} from "@/engine/store";

export const dynamic = "force-dynamic";

// POST /api/assets/:id/regenerate (SPEC §2). Regenerating NEVER mutates the
// existing asset: the pipeline appends a new AssetPair with version+1 for the
// asset's angle, the previous versions stay in the store as history (#16).
// Optional body { model }: curated Fal model for the Designer, values from
// FAL_MODELS only. Job pattern (#7): answers 202 + runId immediately, the
// pipeline continues as a fire-and-forget promise; progress via GET /state.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => null)) as {
    model?: unknown;
  } | null;
  let model: string | undefined;
  if (body?.model !== undefined) {
    if (typeof body.model !== "string" || !isKnownFalModel(body.model)) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_model",
          hint: `model must be one of the curated Fal models: ${FAL_MODELS.map((m) => m.id).join(", ")}`,
        },
        { status: 400 },
      );
    }
    model = body.model;
  }

  const asset = readCollection("assets").find((a) => a.id === id);
  if (!asset) {
    return NextResponse.json(
      { ok: false, error: "asset_not_found" },
      { status: 404 },
    );
  }
  const angle = readCollection("angles").find((a) => a.id === asset.angleId);
  if (!angle || !ensureBrandSeed(angle.brandSlug)) {
    return NextResponse.json(
      { ok: false, error: "angle_not_found" },
      { status: 404 },
    );
  }

  const run = createRun(angle.brandSlug, "assets", angle.id);
  // Backstop against rejections thrown before the pipeline's own try block.
  void generateAssetPair(angle.id, { run, model }).catch((err) => {
    finishRun(run.id, err instanceof Error ? err.message : String(err));
  });
  return NextResponse.json({ ok: true, runId: run.id }, { status: 202 });
}
