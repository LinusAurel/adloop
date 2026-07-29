import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
/** Verification helper: return the stored context packet in plain text. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const { runId } = await context.params;
  const pool = getPool();
  const result = await pool.query<{
    context_packet: string | null;
    prompt_hash: string | null;
    playbook_version: string | null;
    turn_phase: string | null;
  }>(
    `SELECT context_packet, prompt_hash, playbook_version, turn_phase
     FROM run WHERE id = $1 AND tenant_id = $2`,
    [runId, auth.session.tenantId],
  );
  const row = result.rows[0];
  if (!row) return errorResponse(404, "not_found");
  return NextResponse.json(row);
}
