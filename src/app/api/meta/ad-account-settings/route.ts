import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { AdvertiserDefaultsSchema } from "@/publish/settings";
import { loadLatestDefaults, saveDefaults } from "@/publish/resolve";
import { z } from "zod";

const QuerySchema = z.object({
  advertiserId: z.string().uuid(),
});

const BodySchema = z.object({
  advertiserId: z.string().uuid(),
  settings: AdvertiserDefaultsSchema,
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = QuerySchema.safeParse({
    advertiserId: request.nextUrl.searchParams.get("advertiserId"),
  });
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const owned = await pool.query(
    `SELECT 1 FROM advertiser WHERE id = $1 AND tenant_id = $2`,
    [parsed.data.advertiserId, auth.session.tenantId],
  );
  if (owned.rowCount !== 1) return errorResponse(404, "not_found");

  const latest = await loadLatestDefaults(
    pool,
    auth.session.tenantId,
    parsed.data.advertiserId,
  );
  return NextResponse.json({
    advertiserId: parsed.data.advertiserId,
    version: latest?.version ?? null,
    settings: latest?.settings ?? null,
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
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

  const saved = await saveDefaults(pool, {
    tenantId: auth.session.tenantId,
    advertiserId: parsed.data.advertiserId,
    settings: parsed.data.settings,
    createdBy: auth.session.userId,
  });

  return NextResponse.json({
    advertiserId: parsed.data.advertiserId,
    version: saved.version,
    settings: parsed.data.settings,
  });
}
