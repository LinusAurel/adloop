import { NextResponse } from "next/server";
import { analyzeBrand, type AnalyzeOptions } from "@/engine/agents/analyst";
import { requireAdmin } from "@/lib/guard";
import { createRun, ensureBrandSeed, finishRun } from "@/engine/store";

export const dynamic = "force-dynamic";

// POST /api/brands/:slug/optimize -> Analyst/Mining (SPEC §2, Stufe 7).
// Body optional: { mode: "auto" | "live" | "fixture" } — auto liest erst
// echte Insights (Konnektivitätsbeweis) und fällt bei leerem Konto auf die
// klar gelabelte Demo-Fixture zurück. Auch Ziel des n8n-Schedulers.
// Job-Muster (#7): antwortet sofort mit 202 + runId; das AnalysisResult
// landet als run.result im Store und ist über GET /state lesbar.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { slug } = await ctx.params;
  let mode: AnalyzeOptions["mode"] = "auto";
  try {
    const body = (await req.json()) as { mode?: AnalyzeOptions["mode"] };
    if (body.mode === "live" || body.mode === "fixture" || body.mode === "auto") {
      mode = body.mode;
    }
  } catch {
    // kein/ungültiger Body -> auto
  }
  if (!ensureBrandSeed(slug)) {
    return NextResponse.json(
      { ok: false, error: "brand_not_found" },
      { status: 404 },
    );
  }
  const run = createRun(slug, "optimize");
  // Backstop: the agent marks its own failures; this catches anything thrown
  // before its try block and prevents an unhandled rejection.
  void analyzeBrand(slug, { mode, run }).catch((err) => {
    finishRun(run.id, err instanceof Error ? err.message : String(err));
  });
  return NextResponse.json({ ok: true, runId: run.id }, { status: 202 });
}
