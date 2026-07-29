import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { AdvertiserDefaultsSchema } from "@/publish/settings";
import { loadLatestDefaults, saveDefaults } from "@/publish/resolve";
import { PublishError } from "@/publish/schemas";
import { z } from "zod";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
const QuerySchema = z.object({
  advertiserId: z.string().uuid(),
});

const BodySchema = z.object({
  advertiserId: z.string().uuid(),
  /** Optimistic concurrency — must match the loaded version (or null if none). */
  expectedVersion: z.number().int().nonnegative().nullable(),
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

  try {
    const saved = await saveDefaults(pool, {
      tenantId: auth.session.tenantId,
      advertiserId: parsed.data.advertiserId,
      settings: parsed.data.settings,
      createdBy: auth.session.userId,
      expectedVersion: parsed.data.expectedVersion,
    });

    return NextResponse.json({
      advertiserId: parsed.data.advertiserId,
      version: saved.version,
      settings: (await loadLatestDefaults(
        pool,
        auth.session.tenantId,
        parsed.data.advertiserId,
      ))?.settings ?? parsed.data.settings,
    });
  } catch (error) {
    if (
      error instanceof PublishError &&
      error.code === "settings_version_conflict"
    ) {
      return errorResponse(409, "settings_version_conflict", error.params);
    }
    throw error;
  }
}
