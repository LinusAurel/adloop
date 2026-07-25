import { NextResponse } from "next/server";
import { publishBrand } from "@/engine/agents/publisher";
import { requireAdmin } from "@/lib/guard";
import { createRun, ensureBrandSeed, finishRun } from "@/engine/store";

export const dynamic = "force-dynamic";

// POST /api/brands/:slug/publish -> Publisher (SPEC §2, Stufe 6).
// Hard Stop 2: status PAUSED wird serverseitig erzwungen — der Connector
// kennt gar keinen Status-Parameter, Request-Werte werden ignoriert.
// Idempotent: vorhandene campaignId/adsetId und bereits publishte Assets
// (metaIds.adId) werden übersprungen — Doppel-Klick erzeugt keine Duplikate.
// Job-Muster (#7): antwortet sofort mit 202 + runId, Meta-Uploads laufen als
// Fire-and-forget-Promise weiter; Fortschritt über GET /state.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { slug } = await ctx.params;
  const brand = ensureBrandSeed(slug);
  if (!brand) {
    return NextResponse.json(
      { ok: false, error: "brand_not_found" },
      { status: 404 },
    );
  }
  // Onboarded brands have no Meta publisher fields yet — publish stays
  // disabled until a human configures account, page and budget (Hard Stop 4).
  if (
    !brand.meta.adAccountId ||
    !brand.meta.pageId ||
    !brand.meta.fixedDailyBudgetCents
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "publish_not_configured",
        hint: "Meta-Konfiguration (adAccountId, pageId, fixedDailyBudgetCents) fehlt — für neue Brands setzt die ein Mensch, kein Agent",
      },
      { status: 409 },
    );
  }
  const run = createRun(slug, "publish");
  // Backstop: the agent marks its own failures; this catches anything thrown
  // before its try block and prevents an unhandled rejection.
  void publishBrand(slug, { run }).catch((err) => {
    finishRun(run.id, err instanceof Error ? err.message : String(err));
  });
  return NextResponse.json({ ok: true, runId: run.id }, { status: 202 });
}
