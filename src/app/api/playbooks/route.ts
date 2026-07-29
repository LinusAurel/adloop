import { NextRequest, NextResponse } from "next/server";
import { evaluateAccessPolicy } from "@/access/policy";
import { authenticate } from "@/auth/guard";
import { listPlaybooks } from "@/agent/playbooks/resolve";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";

/**
 * The playbooks in effect for this tenant, with their current source. Reading
 * requires the same permission as editing: a playbook is the operating
 * instruction the agent runs on, and its text is not for every member.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const pool = getPool();
  const user = await pool.query<{ role: string }>(
    `SELECT role FROM app_user WHERE id = $1 AND tenant_id = $2`,
    [auth.session.userId, auth.session.tenantId],
  );
  if (!evaluateAccessPolicy(user.rows[0]?.role ?? "").actions.editPlaybooks) {
    return errorResponse(403, "forbidden");
  }

  const playbooks = await listPlaybooks(pool, { tenantId: auth.session.tenantId });
  return NextResponse.json({ playbooks });
}
