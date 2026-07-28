import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import type { JobError, RunStatus } from "@/queue/types";

interface RunRow {
  status: RunStatus;
  result: unknown;
  error: JobError | null;
}

const TERMINAL_ERROR_STATUSES: ReadonlySet<RunStatus> = new Set(["failed", "timed_out", "cancelled"]);

/** §5 GET /api/runs/:id/result */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const pool = getPool();

  const result = await pool.query<RunRow>(`SELECT status, result, error FROM run WHERE id = $1`, [id]);
  const run = result.rows[0];
  if (!run) {
    return errorResponse(404, { code: "NOT_FOUND", message: "run not found", retryable: false });
  }

  if (run.status === "completed") {
    return NextResponse.json({ result: run.result }, { status: 200 });
  }

  if (TERMINAL_ERROR_STATUSES.has(run.status)) {
    return NextResponse.json(
      {
        error: run.error ?? {
          code: run.status.toUpperCase(),
          message: `run ended as ${run.status}`,
          retryable: false,
        },
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ status: run.status }, { status: 202 });
}
