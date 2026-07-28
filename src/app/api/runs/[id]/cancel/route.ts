import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/db/pool";
import { requestCancel } from "@/queue/sql/cancel";
import { errorResponse } from "@/lib/api-error";

/** §5 POST /api/runs/:id/cancel */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const pool = getPool();

  const runResult = await pool.query(`SELECT id FROM run WHERE id = $1`, [id]);
  if (!runResult.rows[0]) {
    return errorResponse(404, { code: "NOT_FOUND", message: "run not found", retryable: false });
  }

  const jobResult = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM job WHERE run_id = $1`,
    [id],
  );
  const job = jobResult.rows[0];
  if (!job) {
    return errorResponse(404, { code: "NOT_FOUND", message: "job not found for run", retryable: false });
  }

  const outcome = await requestCancel(pool, { jobId: job.id, tenantId: job.tenant_id });
  if (outcome.outcome === "already_terminal") {
    return errorResponse(409, {
      code: "ALREADY_TERMINAL",
      message: "run is already terminal",
      retryable: false,
    });
  }

  return NextResponse.json({ status: "cancel_requested" }, { status: 202 });
}
