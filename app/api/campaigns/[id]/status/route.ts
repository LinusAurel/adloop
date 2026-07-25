import { NextResponse } from "next/server";
import { z } from "zod";
import { setDeliveryStatus } from "@/engine/activation";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ status: z.enum(["ACTIVE", "PAUSED"]) });

// POST /api/campaigns/:id/status { status: "ACTIVE" | "PAUSED" } (#17).
// Das Human-Gate: Publishes bleiben immer PAUSED, Aktivierung ist ein
// bewusster Klick auf dieser admin-geschützten Route. :id ist eine
// Kampagnen- oder Ad-ID aus dem eigenen Store; echte Meta-IDs gehen über
// die Graph API, Demo-IDs (demo-…) ändern nur den Store.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_body",
        hint: "body must be { status: \"ACTIVE\" | \"PAUSED\" }",
      },
      { status: 400 },
    );
  }

  try {
    const result = await setDeliveryStatus(id, parsed.data.status);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "unknown_meta_id") {
      return NextResponse.json(
        {
          ok: false,
          error: "unknown_meta_id",
          hint: "id does not match any campaign or published ad in the store",
        },
        { status: 404 },
      );
    }
    // Graph error message only — the connector never leaks tokens.
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
