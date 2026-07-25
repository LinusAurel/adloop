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

// POST /api/angles/:id/assets/generate -> AssetPair (SPEC §2).
// Optionaler Body { model }: kuratiertes Fal-Modell für den Designer (#17),
// nur Werte aus FAL_MODELS. Ohne Body gilt FAL_MODEL_ID bzw. der Default.
// Job-Muster (#7): die Pipeline (Copywriter -> Critic -> Designer) lief im
// Live-Test ~4,5 Min und riss HTTP-Timeouts — deshalb sofort 202 + runId,
// die Arbeit läuft als Fire-and-forget-Promise im Node-Prozess weiter.
// Fortschritt und Abschluss liest die UI über GET /state (Run mit angleId).
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;

  // Body is optional; only { model } is read from it.
  const body = (await req.json().catch(() => null)) as { model?: unknown } | null;
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

  const angle = readCollection("angles").find((a) => a.id === id);
  if (!angle) {
    return NextResponse.json(
      { ok: false, error: "angle_not_found" },
      { status: 404 },
    );
  }
  if (!ensureBrandSeed(angle.brandSlug)) {
    return NextResponse.json(
      { ok: false, error: "brand_not_found" },
      { status: 404 },
    );
  }
  const run = createRun(angle.brandSlug, "assets", angle.id);
  // Backstop: the agent marks its own failures; this catches anything thrown
  // before its try block and prevents an unhandled rejection.
  void generateAssetPair(id, { run, model }).catch((err) => {
    finishRun(run.id, err instanceof Error ? err.message : String(err));
  });
  return NextResponse.json({ ok: true, runId: run.id }, { status: 202 });
}
