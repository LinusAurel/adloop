import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import {
  createOnboardBrand,
  normalizeUrl,
  runScout,
  slugFromUrl,
} from "@/engine/agents/scout";
import { createRun, finishRun, getBrand, upsert } from "@/engine/store";

export const dynamic = "force-dynamic";

// POST /api/onboard { url, name?, product? } -> Scout (SPEC §2, Stufe 1).
// Job-Muster (#7): der Brand-Stub wird synchron angelegt (damit GET /state
// sofort funktioniert), die Antwort ist 202 + runId + slug; Scrape und LLM
// laufen als Fire-and-forget-Promise weiter. Fortschritt über GET /state.
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  let body: { url?: string; name?: string; product?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json(
      { ok: false, error: "url_required" },
      { status: 400 },
    );
  }

  let url: string;
  let slug: string;
  try {
    url = normalizeUrl(body.url);
    slug = slugFromUrl(url);
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_url", hint: "z. B. https://beispiel.de" },
      { status: 400 },
    );
  }

  if (getBrand(slug)) {
    return NextResponse.json(
      { ok: false, error: "brand_exists", slug },
      { status: 409 },
    );
  }

  const input = { url, name: body.name, product: body.product };
  // Stub synchronously so the UI can switch to the new brand immediately.
  upsert("brands", createOnboardBrand(input));
  const run = createRun(slug, "scout");
  // Backstop: the agent marks its own failures; this catches anything thrown
  // before its try block and prevents an unhandled rejection.
  void runScout(input, { run }).catch((err) => {
    finishRun(run.id, err instanceof Error ? err.message : String(err));
  });
  return NextResponse.json({ ok: true, runId: run.id, slug }, { status: 202 });
}
