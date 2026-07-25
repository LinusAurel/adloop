import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { runChat, type ChatMessage } from "@/engine/chat";
import { ensureBrandSeed } from "@/engine/store";

export const dynamic = "force-dynamic";

// POST /api/brands/:slug/chat (#16): the chat is the control surface of the
// engine. Body: { messages: [{ role: "user"|"assistant", content: string }] }.
// Response: { reply, actions: [{ type, label }], stateChanged } — no
// streaming, tool actions run synchronously except the async jobs (#7),
// which report their runId and finish via /state polling.
// Admin-guarded like every mutation route (SPEC §7b).
export async function POST(
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

  let messages: ChatMessage[];
  try {
    const body = (await req.json()) as { messages?: unknown };
    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      !body.messages.every(
        (m: unknown): m is ChatMessage =>
          typeof m === "object" &&
          m !== null &&
          ((m as ChatMessage).role === "user" || (m as ChatMessage).role === "assistant") &&
          typeof (m as ChatMessage).content === "string",
      )
    ) {
      throw new Error("invalid");
    }
    messages = body.messages;
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_body",
        hint: "Body: { messages: [{ role: \"user\"|\"assistant\", content: string }] }, mindestens eine Nachricht",
      },
      { status: 400 },
    );
  }

  try {
    const result = await runChat(slug, messages);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
