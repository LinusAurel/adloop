import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/db/pool";
import { createRun } from "@/queue/create-run";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { errorResponse } from "@/lib/api-error";
import { SEED_TENANT_ID } from "@/lib/constants";

const BodySchema = z.object({
  runId: z.string().uuid(),
  tenantId: z.string().uuid(),
  family: z.string().min(1),
  input: z.unknown(),
});

/** §5 POST /api/runs — idempotent on (runId, tenantId, family, input). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  ensureQueueBootstrapped();
  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(400, {
      code: "VALIDATION_ERROR",
      message: parsed.error.message,
      retryable: false,
    });
  }

  const result = await createRun(getPool(), parsed.data);

  switch (result.outcome) {
    case "created":
    case "idempotent_replay":
      return NextResponse.json(
        { runId: result.runId, statusUrl: `/api/runs/${result.runId}` },
        { status: 201 },
      );
    case "conflict":
      return errorResponse(409, {
        code: "IDEMPOTENCY_CONFLICT",
        message: "runId already used with a different request body",
        retryable: false,
      });
    case "unknown_family":
      return errorResponse(400, {
        code: "UNKNOWN_FAMILY",
        message: `no job family registered as "${parsed.data.family}"`,
        retryable: false,
      });
    case "invalid_input":
      return errorResponse(400, {
        code: "VALIDATION_ERROR",
        message: result.message,
        retryable: false,
      });
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
    [SEED_TENANT_ID],
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
