import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";

const QuerySchema = z.object({
  publicationId: z.string().uuid(),
});

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

  const steps = await pool.query(
    `SELECT id, step_index, operation, status, external_id, attempt,
            lease_expires_at, reconcile_state, external_correlation,
            object_name, error, reconciled_at
     FROM publication_step
     WHERE publication_id = $1
     ORDER BY step_index ASC`,
    [parsed.data.publicationId],
  );

  return NextResponse.json({
    publication: publication.rows[0],
    steps: steps.rows,
  });
}
