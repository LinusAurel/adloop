import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { runStrategist } from "@/engine/agents/strategist";

// Strategist runs LLM calls — never cache, allow a long request window.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/brands/:slug/angles/generate -> Strategist (SPEC §2).
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { slug } = await ctx.params;
  try {
    const result = await runStrategist(slug);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "brand_not_found" ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
