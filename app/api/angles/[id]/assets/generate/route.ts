import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { generateAssetPair } from "@/engine/agents/pipeline";

// Copywriter -> Critic -> Designer runs several LLM calls plus one Fal image;
// the app runs as a local Node process, so long requests are fine (SPEC §0).
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/angles/:id/assets/generate -> AssetPair (SPEC §2).
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const result = await generateAssetPair(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.endsWith("_not_found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
