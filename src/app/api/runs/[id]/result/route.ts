import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import type { JobError, RunStatus } from "@/queue/types";
import { authenticate, requireOwnedResource } from "@/auth/guard";

interface RunRow {
  status: RunStatus;
  result: unknown;
  error: JobError | null;
}

const TERMINAL_ERROR_STATUSES: ReadonlySet<RunStatus> = new Set(["failed", "timed_out", "cancelled"]);

/** §5 GET /api/runs/:id/result */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = authenticate(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const pool = getPool();
  const ownershipError = await requireOwnedResource(pool, auth.session, "run", id);
  if (ownershipError) return ownershipError;

  const result = await pool.query<RunRow>(
    `SELECT status, result, error
     FROM run
     WHERE id = $1 AND tenant_id = $2`,
    [id, auth.session.tenantId],
  );
  const run = result.rows[0];
  if (!run) {
    return errorResponse(404, "not_found");
  }

  if (run.status === "completed") {
    return NextResponse.json({ result: run.result }, { status: 200 });
  }

  if (TERMINAL_ERROR_STATUSES.has(run.status)) {
    return errorResponse(409, run.error?.code.toLowerCase() ?? `run_${run.status}`);
  }

  return NextResponse.json({ status: run.status }, { status: 202 });
}
