import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { runStrategist } from "@/engine/agents/strategist";
import { createRun, ensureBrandSeed, finishRun } from "@/engine/store";

export const dynamic = "force-dynamic";

// POST /api/brands/:slug/angles/generate -> Strategist (SPEC §2).
// Job-Muster (#7): antwortet sofort mit 202 + runId, die LLM-Arbeit läuft
// als Fire-and-forget-Promise im Node-Prozess weiter (lokal/Render, kein
// Serverless). Fortschritt und Abschluss liest die UI über GET /state.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { slug } = await ctx.params;
  if (!ensureBrandSeed(slug)) {
    return NextResponse.json(
      { ok: false, error: "brand_not_found" },
      { status: 404 },
    );
  }
  const run = createRun(slug, "strategist");
  // Backstop: the agent marks its own failures; this catches anything thrown
  // before its try block and prevents an unhandled rejection.
  void runStrategist(slug, { run }).catch((err) => {
    finishRun(run.id, err instanceof Error ? err.message : String(err));
  });
  return NextResponse.json({ ok: true, runId: run.id }, { status: 202 });
}
