import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { dataDir } from "@/engine/store";

export const dynamic = "force-dynamic";

// GET /api/asset-files/:name — liefert lokal gespeicherte Statics aus
// data/assets/ (z. B. die Demo-Fixtures aus #13), damit das Studio ohne
// Remote-URL rendert. Strikte Namens-Whitelist statt Pfad-Auflösung.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!/^[A-Za-z0-9_-]+\.png$/.test(name)) {
    return NextResponse.json({ ok: false, error: "invalid_name" }, { status: 400 });
  }
  const file = path.join(dataDir(), "assets", name);
  if (!fs.existsSync(file)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(fs.readFileSync(file)), {
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store",
    },
  });
}
