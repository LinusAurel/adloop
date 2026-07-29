import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import {
  CreateChatRunInputSchema,
  createChatRun,
} from "@/agent/create-chat-run";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
const BodySchema = CreateChatRunInputSchema.omit({
  tenantId: true,
  userId: true,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const chatOwned = await pool.query(
    `SELECT 1 FROM chat WHERE id = $1 AND tenant_id = $2`,
    [parsed.data.chatId, auth.session.tenantId],
  );
  if (chatOwned.rowCount !== 1) return errorResponse(404, "not_found");

  ensureQueueBootstrapped();
  const result = await createChatRun(pool, {
    ...parsed.data,
    tenantId: auth.session.tenantId,
    userId: auth.session.userId,
  });

  if (result.outcome === "chat_not_found") return errorResponse(404, "not_found");
  if (result.outcome === "conflict") return errorResponse(409, "idempotency_conflict");

  return NextResponse.json(
    {
      runId: result.runId,
      eventsUrl: `/api/chat/runs/${result.runId}/events`,
    },
    { status: 202 },
  );
}
