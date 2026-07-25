import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { readCollection, writeCollection } from "@/engine/store";

export const dynamic = "force-dynamic";

// POST /api/assets/:id/reject (SPEC §2). Human gate — see approve route.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const assets = readCollection("assets");
  const asset = assets.find((a) => a.id === id);
  if (!asset) {
    return NextResponse.json({ ok: false, error: "asset_not_found" }, { status: 404 });
  }
  asset.status = "rejected";
  writeCollection("assets", assets);
  return NextResponse.json({ ok: true, asset });
}
