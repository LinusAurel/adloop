import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/db/pool";
import { createRun } from "@/queue/create-run";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { errorResponse } from "@/lib/api-error";
import { authenticate } from "@/auth/guard";

const BodySchema = z.object({
  runId: z.string().uuid(),
  family: z.string().min(1),
  input: z.unknown(),
});

/** §5 POST /api/runs — idempotent on (runId, tenantId, family, input). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authenticate(req);
  if (!auth.ok) return auth.response;

  ensureQueueBootstrapped();
  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(400, "validation_error");
  }

  const result = await createRun(getPool(), {
    ...parsed.data,
    tenantId: auth.session.tenantId,
  });

  switch (result.outcome) {
    case "created":
    case "idempotent_replay":
      return NextResponse.json(
        { runId: result.runId, statusUrl: `/api/runs/${result.runId}` },
        { status: 201 },
      );
    case "conflict":
      return errorResponse(409, "idempotency_conflict");
    case "concurrency_conflict":
      return errorResponse(409, "sync_in_progress");
    case "unknown_family":
      return errorResponse(400, "unknown_family", { family: parsed.data.family });
    case "invalid_input":
      return errorResponse(400, "validation_error");
  }
}

interface RunListRow {
  id: string;
  kind: string;
  status: string;
  result: unknown;
  created_at: string;
  updated_at: string;
  job_status: string | null;
  job_attempts: number | null;
  job_progress: unknown;
}

/** §5 GET /api/runs?status=active — plus an unfiltered mode the UI uses to show recent history (extension, see DECISIONS.md). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = authenticate(req);
  if (!auth.ok) return auth.response;

  const status = req.nextUrl.searchParams.get("status");
  const pool = getPool();

  const whereClause = status === "active" ? "AND r.status IN ('queued', 'running')" : "";

  const { rows } = await pool.query<RunListRow>(
    `SELECT r.id, r.kind, r.status, r.result, r.created_at, r.updated_at,
            j.status AS job_status, j.attempts AS job_attempts, j.progress AS job_progress
     FROM run r
     LEFT JOIN job j ON j.run_id = r.id
     WHERE r.tenant_id = $1 ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [auth.session.tenantId],
  );

  return NextResponse.json({
    runs: rows.map((r) => ({
      runId: r.id,
      kind: r.kind,
      status: r.status,
      result: r.result,
      job: { status: r.job_status, attempts: r.job_attempts, progress: r.job_progress },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
}
