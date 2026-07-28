import { NextRequest } from "next/server";
import { authenticate } from "@/auth/guard";
import { listRunEventsAfter, type RunEventRow } from "@/agent/run-events";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE event stream for a chat run.
 *
 * ?after=<seq> delivers events with seq strictly greater than after.
 * Terminal events are persisted (not only streamed). Delivery at disconnect
 * is best-effort — the client MUST dedupe by seq (auftrag §0.3).
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const { runId } = await context.params;
  const afterParam = request.nextUrl.searchParams.get("after");
  let afterSeq = afterParam ? Number(afterParam) : 0;
  if (!Number.isFinite(afterSeq) || afterSeq < 0) afterSeq = 0;

  const pool = getPool();
  const owned = await pool.query(
    `SELECT 1 FROM run WHERE id = $1 AND tenant_id = $2`,
    [runId, auth.session.tenantId],
  );
  if (owned.rowCount !== 1) return errorResponse(404, "not_found");

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };

      const pushEvents = (events: RunEventRow[]) => {
        for (const event of events) {
          const seq = Number(event.seq);
          send(`id: ${seq}\n`);
          send(`event: ${event.kind}\n`);
          send(`data: ${JSON.stringify({ seq, kind: event.kind, payload: event.payload })}\n\n`);
          afterSeq = seq;
          if (event.kind === "terminal") {
            send(`data: [DONE]\n\n`);
            closed = true;
            controller.close();
            return true;
          }
        }
        return false;
      };

      // Catch up first.
      const initial = await listRunEventsAfter(pool, { runId, afterSeq });
      if (pushEvents(initial)) return;

      const heartbeat = setInterval(() => {
        send(`: hb ${Date.now()}\n\n`);
      }, 15_000);

      try {
        while (!closed) {
          await new Promise((r) => setTimeout(r, 400));
          const batch = await listRunEventsAfter(pool, { runId, afterSeq });
          if (pushEvents(batch)) break;

          const status = await pool.query<{
            status: string;
            turn_phase: string | null;
          }>(`SELECT status, turn_phase FROM run WHERE id = $1`, [runId]);
          const row = status.rows[0];
          if (
            row &&
            ["completed", "failed", "timed_out", "cancelled"].includes(row.status) &&
            batch.length === 0
          ) {
            // Terminal run without a terminal event (legacy / race) — close.
            send(`data: [DONE]\n\n`);
            break;
          }
        }
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
