import fs from "node:fs";
import { NextResponse } from "next/server";
import {
  briefingFilePath,
  generateBriefing,
  isSafeBriefingFileName,
  latestBriefingFile,
} from "@/engine/agents/briefing";
import { requireAdmin } from "@/lib/guard";

// POST /api/brands/:slug/briefing -> Audio-Briefing generieren (Admin-Guard
// wie alle Mutations-Routen, SPEC §7b): Analyst-Ergebnis -> LLM-Skript ->
// ElevenLabs-mp3 unter data/briefings/, Response liefert URL + Sprechtext.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { slug } = await ctx.params;
  try {
    const result = await generateBriefing(slug);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith("brand_not_found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

// GET /api/brands/:slug/briefing[?file=<name>] -> mp3 streamen (Read-Route,
// offen wie /state). Ohne file-Parameter wird das neueste Briefing geliefert.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const requested = new URL(req.url).searchParams.get("file");
  if (requested && !isSafeBriefingFileName(slug, requested)) {
    return NextResponse.json({ ok: false, error: "invalid_file" }, { status: 400 });
  }
  const fileName = requested ?? latestBriefingFile(slug);
  if (!fileName) {
    return NextResponse.json(
      { ok: false, error: "no_briefing", hint: "erst POST auf diese Route" },
      { status: 404 },
    );
  }
  const filePath = briefingFilePath(fileName);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ ok: false, error: "no_briefing" }, { status: 404 });
  }
  const bytes = fs.readFileSync(filePath);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store",
    },
  });
}
