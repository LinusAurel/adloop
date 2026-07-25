import { NextResponse } from "next/server";
import { applyBrandPatch } from "@/engine/brand-edit";
import { brandPatchSchema } from "@/engine/schemas";
import { ensureBrandSeed } from "@/engine/store";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

// PATCH /api/brands/:slug (#17) — Brand-Editing für Menschen, admin-geschützt
// wie alle Mutations-Routen. Body: beliebige Teilmenge der editierbaren
// brand.json-Felder (siehe brandPatchSchema); unbekannte Felder werden mit
// 400 abgelehnt. Schreibt Store UND brands/<slug>/brand.json (falls lokal
// vorhanden).
export async function PATCH(
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

  const json = await req.json().catch(() => null);
  const parsed = brandPatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const brand = applyBrandPatch(slug, parsed.data);
  return NextResponse.json({ ok: true, brand });
}
