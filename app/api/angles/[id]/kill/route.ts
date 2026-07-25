import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { readCollection, writeCollection } from "@/engine/store";

export const dynamic = "force-dynamic";

// POST /api/angles/:id/kill (SPEC §2). Kill is a HUMAN gate (Hard Stop 3) —
// this route only executes the decision a person made in the UI.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const angles = readCollection("angles");
  const angle = angles.find((a) => a.id === id);
  if (!angle) {
    return NextResponse.json({ ok: false, error: "angle_not_found" }, { status: 404 });
  }
  angle.status = "killed";
  writeCollection("angles", angles);
  return NextResponse.json({ ok: true, angle });
}
