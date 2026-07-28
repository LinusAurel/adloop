import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, requireOwnedResource } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { MetricConfigError } from "@/metrics/action-overlaps";
import { assignMetricToAdAccount } from "@/metrics/store";

const BodySchema = z.object({
  metaAdAccountId: z.string().uuid(),
  conversionMetricId: z.string().uuid(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const ownershipError = await requireOwnedResource(
    pool,
    auth.session,
    "metaAdAccount",
    parsed.data.metaAdAccountId,
  );
  if (ownershipError) return ownershipError;

  try {
    const result = await assignMetricToAdAccount(pool, {
      tenantId: auth.session.tenantId,
      metaAdAccountId: parsed.data.metaAdAccountId,
      conversionMetricId: parsed.data.conversionMetricId,
      effectiveFrom: parsed.data.effectiveFrom,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof MetricConfigError) {
      return errorResponse(404, error.code);
    }
    throw error;
  }
}
