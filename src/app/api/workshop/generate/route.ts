import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { authenticate } from "@/auth/guard";
import {
  createPendingApproval,
  decideApproval,
  executePersistedApproval,
} from "@/agent/tools/approvals";
import { ensureToolsBootstrapped } from "@/agent/tools/bootstrap";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import {
  GenerationInputsSchema,
  estimateGenerationCost,
  resolveGenerationInputs,
  ProviderNotAllowedError,
} from "@/images/generate";
import { generateImagesTool } from "@/agent/tools/generate-images";
import { sha256Canonical } from "@/lib/canonical-json";

ensureQueueBootstrapped();
ensureToolsBootstrapped();

const BodySchema = GenerationInputsSchema;

/**
 * Workshop entry: resolve inputs, create a pending Freigabe with cost
 * estimate. Does not call the provider until the approval is decided and
 * executed — same tool path as the agent (no side door).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const owned = await pool.query(
    `SELECT 1 FROM advertiser WHERE id = $1 AND tenant_id = $2`,
    [parsed.data.advertiserId, auth.session.tenantId],
  );
  if (owned.rowCount !== 1) return errorResponse(404, "not_found");

  let resolved;
  try {
    resolved = await resolveGenerationInputs(pool, auth.session.tenantId, parsed.data);
  } catch (error) {
    if (error instanceof ProviderNotAllowedError) {
      return errorResponse(400, "provider_not_allowed");
    }
    return errorResponse(404, "not_found");
  }
  const costEstimate = estimateGenerationCost(resolved);
  const resolvedPayload = {
    inputs: parsed.data,
    resolved,
    costEstimate,
  };

  const runId = uuidv7();
  await pool.query(
    `INSERT INTO run (id, tenant_id, kind, status, input, created_at, updated_at)
     VALUES ($1, $2, 'workshop_request', 'queued', $3::jsonb, now(), now())`,
    [runId, auth.session.tenantId, JSON.stringify(resolvedPayload)],
  );

  const approval = await createPendingApproval(pool, {
    tenantId: auth.session.tenantId,
    runId,
    toolName: generateImagesTool.name,
    toolVersion: generateImagesTool.version,
    resolvedPayload,
    costEstimate: JSON.stringify(costEstimate),
  });

  return NextResponse.json(
    {
      runId,
      approvalId: approval.id,
      costEstimate,
      resolved,
      resolvedRequestHash: approval.resolved_request_hash,
      statusCode: "approval_required",
    },
    { status: 202 },
  );
}

const ExecuteSchema = z.object({
  approvalId: z.string().uuid(),
  approve: z.boolean(),
});

/**
 * Decide Freigabe and, on approve, execute the persisted tool payload
 * (enqueues image_generation). Idempotency reservation happens inside the
 * tool/job path.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = ExecuteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const decided = await decideApproval(pool, {
    approvalId: parsed.data.approvalId,
    tenantId: auth.session.tenantId,
    userId: auth.session.userId,
    approve: parsed.data.approve,
  });
  if (!decided) return errorResponse(409, "approval_not_decidable");

  if (!parsed.data.approve) {
    return NextResponse.json({ statusCode: "denied", approvalId: decided.id });
  }

  const executed = await executePersistedApproval(pool, {
    approvalId: decided.id,
    tenantId: auth.session.tenantId,
    ctx: {
      tenantId: auth.session.tenantId,
      userId: auth.session.userId,
      runId: decided.run_id,
      signal: request.signal,
      agentLocale: "de",
    },
  });

  if (executed.outcome === "rejected") {
    return errorResponse(409, executed.code);
  }
  if (executed.outcome === "needs_approval") {
    return errorResponse(409, "approval_required");
  }

  return NextResponse.json({
    statusCode: "submitted",
    operationId: executed.operationId,
    result: executed.result,
  });
}

// Keep hash helper referenced so tree-shaking doesn't drop the shared path
// the approval row uses — tests assert the same algorithm.
void sha256Canonical;
