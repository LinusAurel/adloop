import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";

const QuerySchema = z.object({
  publicationId: z.string().uuid(),
});

/** Strip the internal [adloop:…] marker — correlation must not leave the system. */
function publicObjectName(name: string): string {
  return name.replace(/\s*\[adloop:[^\]]+\]/g, "").trim();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = QuerySchema.safeParse({
    publicationId: request.nextUrl.searchParams.get("publicationId"),
  });
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const publication = await pool.query(
    `SELECT id, status, binding_version, deviation_reason, budget_source,
            idempotency_key, created_at, updated_at
     FROM publication
     WHERE id = $1 AND tenant_id = $2`,
    [parsed.data.publicationId, auth.session.tenantId],
  );
  if (publication.rowCount !== 1) return errorResponse(404, "not_found");

  const steps = await pool.query<{
    id: string;
    step_index: number;
    operation: string;
    status: string;
    external_id: string | null;
    attempt: number;
    lease_expires_at: string | null;
    reconcile_state: string;
    object_name: string;
    error: unknown;
    reconciled_at: string | null;
  }>(
    `SELECT id, step_index, operation, status, external_id, attempt,
            lease_expires_at, reconcile_state,
            object_name, error, reconciled_at
     FROM publication_step
     WHERE publication_id = $1
     ORDER BY step_index ASC`,
    [parsed.data.publicationId],
  );

  return NextResponse.json({
    publication: publication.rows[0],
    steps: steps.rows.map((step) => ({
      id: step.id,
      step_index: step.step_index,
      operation: step.operation,
      status: step.status,
      external_id: step.external_id,
      attempt: step.attempt,
      lease_expires_at: step.lease_expires_at,
      reconcile_state: step.reconcile_state,
      object_name: publicObjectName(step.object_name),
      error: step.error,
      reconciled_at: step.reconciled_at,
    })),
  });
}
