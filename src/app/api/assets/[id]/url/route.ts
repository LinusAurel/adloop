import { NextRequest, NextResponse } from "next/server";
import { authenticate, requireOwnedResource } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { getObjectStore } from "@/storage/object-store";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const pool = getPool();

  const ownershipError = await requireOwnedResource(pool, auth.session, "asset", id);
  if (ownershipError) return ownershipError;

  const result = await pool.query<{ storage_key: string; mime: string }>(
    `SELECT storage_key, mime FROM asset WHERE id = $1 AND tenant_id = $2`,
    [id, auth.session.tenantId],
  );
  const row = result.rows[0];
  if (!row) return errorResponse(404, "not_found");

  const expiresIn = Number(request.nextUrl.searchParams.get("expiresIn") ?? "300");
  const store = getObjectStore();
  const url = await store.getSignedUrl(
    row.storage_key,
    Math.min(Math.max(expiresIn, 1), 3600),
  );
  return NextResponse.json({ url, expiresIn, mime: row.mime });
}
