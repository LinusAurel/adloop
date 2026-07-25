import { NextResponse } from "next/server";
import { publishBrand } from "@/engine/agents/publisher";
import { requireAdmin } from "@/lib/guard";

// POST /api/brands/:slug/publish -> Publisher (SPEC §2, Stufe 6).
// Hard Stop 2: status PAUSED wird serverseitig erzwungen — der Connector
// kennt gar keinen Status-Parameter, Request-Werte werden ignoriert.
// Idempotent: vorhandene campaignId/adsetId und bereits publishte Assets
// (metaIds.adId) werden übersprungen — Doppel-Klick erzeugt keine Duplikate.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { slug } = await ctx.params;
  try {
    const result = await publishBrand(slug);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith("brand_not_found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
