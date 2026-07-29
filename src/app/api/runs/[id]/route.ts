import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import type { JobProgress, JobStatus, RunStatus } from "@/queue/types";
import { authenticate, requireOwnedResource } from "@/auth/guard";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = authenticate(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const pool = getPool();
  const ownershipError = await requireOwnedResource(pool, auth.session, "run", id);
  if (ownershipError) return ownershipError;

  const runResult = await pool.query<RunRow>(
    `SELECT id, status, created_at, updated_at
     FROM run
     WHERE id = $1 AND tenant_id = $2`,
    [id, auth.session.tenantId],
  );
  const run = runResult.rows[0];
  if (!run) {
    return errorResponse(404, "not_found");
  }

  const jobResult = await pool.query<JobRow>(
    `SELECT status, attempts, progress
     FROM job
     WHERE run_id = $1 AND tenant_id = $2`,
    [id, auth.session.tenantId],
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
