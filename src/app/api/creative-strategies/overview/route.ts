import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, requireOwnedResource } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { buildStrategistOverview } from "@/strategist/overview";

const QuerySchema = z.object({
  metaAdAccountId: z.string().uuid(),
  windowStart: z.string().date(),
  windowEnd: z.string().date(),
  dataAsOf: z.string().min(1).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  ensureQueueBootstrapped();
  const parsed = QuerySchema.safeParse({
    metaAdAccountId: request.nextUrl.searchParams.get("metaAdAccountId"),
    windowStart: request.nextUrl.searchParams.get("windowStart"),
    windowEnd: request.nextUrl.searchParams.get("windowEnd"),
    dataAsOf: request.nextUrl.searchParams.get("dataAsOf") ?? undefined,
  });
  if (!parsed.success) return errorResponse(400, "validation_error");
  if (parsed.data.windowStart > parsed.data.windowEnd) {
    return errorResponse(400, "invalid_window");
  }

  const pool = getPool();
  const ownershipError = await requireOwnedResource(
    pool,
    auth.session,
    "metaAdAccount",
    parsed.data.metaAdAccountId,
  );
  if (ownershipError) return ownershipError;

  const overview = await buildStrategistOverview({
    pool,
    tenantId: auth.session.tenantId,
    metaAdAccountId: parsed.data.metaAdAccountId,
    windowStart: parsed.data.windowStart,
    windowEnd: parsed.data.windowEnd,
    dataAsOf: parsed.data.dataAsOf,
  });

  return NextResponse.json(overview);
}
