import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { BrandProfileSchema } from "@/brand/profile";
import {
  BrandProfileError,
  loadLatestBrandProfile,
  saveBrandProfile,
} from "@/brand/store";

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
  profile: BrandProfileSchema,
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

  try {
    const latest = await loadLatestBrandProfile(
      pool,
      auth.session.tenantId,
      parsed.data.advertiserId,
    );
    return NextResponse.json({
      advertiserId: parsed.data.advertiserId,
      version: latest?.version ?? null,
      profile: latest?.profile ?? null,
    });
  } catch (error) {
    if (error instanceof BrandProfileError) {
      return errorResponse(500, error.code, error.params);
    }
    throw error;
  }
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
    const saved = await saveBrandProfile(pool, {
      tenantId: auth.session.tenantId,
      advertiserId: parsed.data.advertiserId,
      profile: parsed.data.profile,
      createdBy: auth.session.userId,
      expectedVersion: parsed.data.expectedVersion,
    });
    // Echo the normalised profile: the client would otherwise keep showing the
    // blank rows and stray whitespace that were dropped on the way in.
    return NextResponse.json({
      advertiserId: parsed.data.advertiserId,
      version: saved.version,
      profile: saved.profile,
    });
  } catch (error) {
    if (error instanceof BrandProfileError) {
      return errorResponse(
        error.code === "brand_profile_version_conflict" ? 409 : 500,
        error.code,
        error.params,
      );
    }
    throw error;
  }
}
