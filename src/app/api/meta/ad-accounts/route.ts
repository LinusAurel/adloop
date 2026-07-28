import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { withTransaction } from "@/db/queryable";
import { errorResponse } from "@/lib/api-error";

const BodySchema = z.object({
  selectedAccountIds: z.array(z.string().regex(/^act_\d+$/)).max(20),
});

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");
  const selected = [...new Set(parsed.data.selectedAccountIds)];
  const pool = getPool();

  const found = await pool.query<{ meta_ad_account_id: string }>(
    `SELECT meta_ad_account_id
     FROM meta_ad_account
     WHERE tenant_id = $1
       AND meta_ad_account_id = ANY($2::text[])`,
    [auth.session.tenantId, selected],
  );
  if (found.rowCount !== selected.length) return errorResponse(404, "not_found");

  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE meta_ad_account
       SET selected = false, updated_at = now()
       WHERE tenant_id = $1`,
      [auth.session.tenantId],
    );
    if (selected.length > 0) {
      await client.query(
        `UPDATE meta_ad_account
         SET selected = true, updated_at = now()
         WHERE tenant_id = $1
           AND meta_ad_account_id = ANY($2::text[])`,
        [auth.session.tenantId, selected],
      );
    }
  });

  return NextResponse.json({ selectedAccountIds: selected });
}
