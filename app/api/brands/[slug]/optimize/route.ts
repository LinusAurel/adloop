import { NextResponse } from "next/server";
import { analyzeBrand, type AnalyzeOptions } from "@/engine/agents/analyst";
import { requireAdmin } from "@/lib/guard";

// POST /api/brands/:slug/optimize -> Analyst/Mining (SPEC §2, Stufe 7).
// Body optional: { mode: "auto" | "live" | "fixture" } — auto liest erst
// echte Insights (Konnektivitätsbeweis) und fällt bei leerem Konto auf die
// klar gelabelte Demo-Fixture zurück. Auch Ziel des n8n-Schedulers.
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
  try {
    const result = await analyzeBrand(slug, { mode });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith("brand_not_found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
