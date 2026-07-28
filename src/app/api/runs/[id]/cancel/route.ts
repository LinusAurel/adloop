import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/db/pool";
import { requestCancel } from "@/queue/sql/cancel";
import { errorResponse } from "@/lib/api-error";
import { authenticate, requireOwnedResource } from "@/auth/guard";

/** §5 POST /api/runs/:id/cancel */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = authenticate(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const pool = getPool();
  const ownershipError = await requireOwnedResource(pool, auth.session, "run", id);
  if (ownershipError) return ownershipError;

  const runResult = await pool.query(
    `SELECT id FROM run WHERE id = $1 AND tenant_id = $2`,
    [id, auth.session.tenantId],
  );
  if (!runResult.rows[0]) {
    return errorResponse(404, "not_found");
  }

  const jobResult = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id
     FROM job
     WHERE run_id = $1 AND tenant_id = $2`,
    [id, auth.session.tenantId],
  );
  const job = jobResult.rows[0];
  if (!job) {
    return errorResponse(404, "not_found");
  }

  const outcome = await requestCancel(pool, { jobId: job.id, tenantId: job.tenant_id });
  if (outcome.outcome === "already_terminal") {
    return errorResponse(409, "already_terminal");
  }

  return NextResponse.json({ status: "cancel_requested" }, { status: 202 });
}
