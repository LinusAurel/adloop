import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { authenticate } from "@/auth/guard";
import { createPendingApproval } from "@/agent/tools/approvals";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import {
  estimateGenerationCost,
  resolveGenerationInputs,
} from "@/images/generate";
import { generateImagesTool } from "@/agent/tools/generate-images";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
ensureQueueBootstrapped();

const BodySchema = z.object({
  parentCreativeId: z.string().uuid(),
  reason: z.string().min(1),
  count: z.number().int().min(1).max(10).default(1),
  clientRequestId: z.string().min(1),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const parent = await pool.query<{
    id: string;
    advertiser_id: string;
    aspect_ratio: string;
    headline: string;
    primary_text: string;
  }>(
    `SELECT id, advertiser_id, aspect_ratio, headline, primary_text
     FROM creative WHERE id = $1 AND tenant_id = $2`,
    [parsed.data.parentCreativeId, auth.session.tenantId],
  );
  const row = parent.rows[0];
  if (!row) return errorResponse(404, "not_found");

  const inputs = {
    advertiserId: row.advertiser_id,
    prompt: `Variation of: ${row.headline}. ${row.primary_text}`,
    aspectRatio: row.aspect_ratio as "1:1" | "4:5" | "9:16" | "16:9",
    count: parsed.data.count,
    clientRequestId: parsed.data.clientRequestId,
    parentCreativeId: row.id,
    variationReason: parsed.data.reason,
  };

  const resolved = await resolveGenerationInputs(pool, auth.session.tenantId, inputs);
  const costEstimate = estimateGenerationCost(resolved);
  const resolvedPayload = { inputs, resolved, costEstimate };

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
      parentCreativeId: row.id,
      statusCode: "approval_required",
    },
    { status: 202 },
  );
}
