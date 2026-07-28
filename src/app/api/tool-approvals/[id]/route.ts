import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/auth/guard";
import { decideApproval } from "@/agent/tools/approvals";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";

const BodySchema = z.object({
  approve: z.boolean(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const owned = await pool.query(
    `SELECT 1 FROM tool_approval WHERE id = $1 AND tenant_id = $2`,
    [id, auth.session.tenantId],
  );
  if (owned.rowCount !== 1) return errorResponse(404, "not_found");

  const row = await decideApproval(pool, {
    approvalId: id,
    tenantId: auth.session.tenantId,
    userId: auth.session.userId,
    approve: parsed.data.approve,
  });
  if (!row) return errorResponse(409, "approval_not_decidable");

  return NextResponse.json({
    id: row.id,
    decidedAt: row.decided_at,
    resolvedRequestHash: row.resolved_request_hash,
    resolvedPayload: row.resolved_payload,
    operationId: row.operation_id,
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, tool_name, tool_version, resolved_payload, resolved_request_hash,
            operation_id, cost_estimate, decided_at, expires_at, consumed_at
     FROM tool_approval
     WHERE id = $1 AND tenant_id = $2`,
    [id, auth.session.tenantId],
  );
  const row = result.rows[0];
  if (!row) return errorResponse(404, "not_found");
  return NextResponse.json(row);
}
