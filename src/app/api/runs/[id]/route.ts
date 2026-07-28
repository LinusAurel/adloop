import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import type { JobProgress, JobStatus, RunStatus } from "@/queue/types";

interface RunRow {
  id: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  status: JobStatus;
  attempts: number;
  progress: JobProgress | null;
}

/** §5 GET /api/runs/:id */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const pool = getPool();

  const runResult = await pool.query<RunRow>(
    `SELECT id, status, created_at, updated_at FROM run WHERE id = $1`,
    [id],
  );
  const run = runResult.rows[0];
  if (!run) {
    return errorResponse(404, { code: "NOT_FOUND", message: "run not found", retryable: false });
  }

  const jobResult = await pool.query<JobRow>(
    `SELECT status, attempts, progress FROM job WHERE run_id = $1`,
    [id],
  );
  const job = jobResult.rows[0] ?? null;

  return NextResponse.json({
    runId: run.id,
    status: run.status,
    job: job ? { status: job.status, attempts: job.attempts, progress: job.progress } : null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  });
}
