import { NextResponse } from "next/server";
import { getBrandState } from "@/engine/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const state = getBrandState(slug);
  if (!state) {
    return NextResponse.json(
      { ok: false, error: "brand_not_found", slug },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, ...state });
}
