import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, requireOwnedResource } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";

const BodySchema = z.object({
  contentLocale: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const { id } = await params;
  const pool = getPool();
  const ownershipError = await requireOwnedResource(pool, auth.session, "advertiser", id);
  if (ownershipError) return ownershipError;

  await pool.query(
    `UPDATE advertiser
     SET content_locale = $1, updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [parsed.data.contentLocale, id, auth.session.tenantId],
  );
  return NextResponse.json({ contentLocale: parsed.data.contentLocale });
}
