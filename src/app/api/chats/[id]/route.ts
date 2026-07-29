import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const pool = getPool();
  const chat = await pool.query(
    `SELECT id, project_id, name, name_code, name_params, summary, archived, pinned, awaiting_clarify
     FROM chat WHERE id = $1 AND tenant_id = $2`,
    [id, auth.session.tenantId],
  );
  if (!chat.rows[0]) return errorResponse(404, "not_found");
  const messages = await pool.query(
    `SELECT id, role, content, content_code, content_params, tool_invocations, render_artifacts, run_id, created_at
     FROM message WHERE chat_id = $1 AND tenant_id = $2
     ORDER BY created_at ASC`,
    [id, auth.session.tenantId],
  );
  return NextResponse.json({ chat: chat.rows[0], messages: messages.rows });
}
