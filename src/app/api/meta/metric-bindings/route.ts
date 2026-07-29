import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { withTransaction } from "@/db/queryable";
import { errorResponse } from "@/lib/api-error";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
import {
  OptimizationGoalSchema,
  PromotedObjectSchema,
  BindingAttributionSpecSchema,
} from "@/publish/settings";

const QuerySchema = z.object({
  conversionMetricId: z.string().uuid(),
});

const BodySchema = z.object({
  conversionMetricId: z.string().uuid(),
  conversionMetricVersion: z.number().int().positive(),
  optimizationGoal: OptimizationGoalSchema,
  promotedObject: PromotedObjectSchema,
  attributionSpec: BindingAttributionSpecSchema,
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = QuerySchema.safeParse({
    conversionMetricId: request.nextUrl.searchParams.get("conversionMetricId"),
  });
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const result = await pool.query(
    `SELECT id, conversion_metric_id, conversion_metric_version,
            optimization_goal, promoted_object, attribution_spec,
            version, active, created_at
     FROM metric_optimization_binding
     WHERE tenant_id = $1 AND conversion_metric_id = $2 AND active = true
     LIMIT 1`,
    [auth.session.tenantId, parsed.data.conversionMetricId],
  );
  const row = result.rows[0];
  if (!row) return NextResponse.json({ binding: null });

  const attr = BindingAttributionSpecSchema.safeParse(row.attribution_spec);
  if (!attr.success) {
    return errorResponse(422, "binding_data_corrupt", { bindingId: row.id });
  }
  const promoted = PromotedObjectSchema.safeParse(row.promoted_object);
  if (!promoted.success) {
    return errorResponse(422, "binding_data_corrupt", { bindingId: row.id });
  }
  const goal = OptimizationGoalSchema.safeParse(row.optimization_goal);
  if (!goal.success) {
    return errorResponse(422, "binding_data_corrupt", { bindingId: row.id });
  }

  return NextResponse.json({ binding: row });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const metric = await pool.query(
    `SELECT 1 FROM conversion_metric
     WHERE id = $1 AND version = $2 AND tenant_id = $3`,
    [
      parsed.data.conversionMetricId,
      parsed.data.conversionMetricVersion,
      auth.session.tenantId,
    ],
  );
  if (metric.rowCount !== 1) return errorResponse(404, "not_found");

  const binding = await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE metric_optimization_binding
       SET active = false
       WHERE tenant_id = $1 AND conversion_metric_id = $2 AND active = true`,
      [auth.session.tenantId, parsed.data.conversionMetricId],
    );
    const latest = await client.query<{ version: number }>(
      `SELECT version FROM metric_optimization_binding
       WHERE tenant_id = $1 AND conversion_metric_id = $2
       ORDER BY version DESC LIMIT 1`,
      [auth.session.tenantId, parsed.data.conversionMetricId],
    );
    const version = (latest.rows[0]?.version ?? 0) + 1;
    const id = uuidv7();
    const inserted = await client.query(
      `INSERT INTO metric_optimization_binding (
         id, tenant_id, conversion_metric_id, conversion_metric_version,
         optimization_goal, promoted_object, attribution_spec,
         version, active
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, true)
       RETURNING *`,
      [
        id,
        auth.session.tenantId,
        parsed.data.conversionMetricId,
        parsed.data.conversionMetricVersion,
        parsed.data.optimizationGoal,
        JSON.stringify(parsed.data.promotedObject),
        parsed.data.attributionSpec,
        version,
      ],
    );
    return inserted.rows[0];
  });

  return NextResponse.json({ binding });
}
