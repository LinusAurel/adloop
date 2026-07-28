import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { CreateConversionMetricSchema } from "@/metrics/definition";
import { MetricConfigError } from "@/metrics/action-overlaps";
import {
  createConversionMetric,
  listConversionMetrics,
} from "@/metrics/store";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const metrics = await listConversionMetrics(getPool(), auth.session.tenantId);
  return NextResponse.json({ metrics });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = CreateConversionMetricSchema.safeParse(body);
  if (!parsed.success) {
    const overlapping = parsed.error.issues.some(
      (issue) => issue.message === "overlapping_action_types",
    );
    return errorResponse(
      400,
      overlapping ? "overlapping_action_types" : "validation_error",
    );
  }

  try {
    const metric = await createConversionMetric(getPool(), {
      tenantId: auth.session.tenantId,
      input: parsed.data,
    });
    return NextResponse.json({ metric }, { status: 201 });
  } catch (error) {
    if (error instanceof MetricConfigError) {
      return errorResponse(400, error.code);
    }
    throw error;
  }
}
