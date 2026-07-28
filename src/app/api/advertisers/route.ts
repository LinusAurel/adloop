import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const pool = getPool();
  const result = await pool.query<{ id: string; name: string; content_locale: string }>(
    `SELECT id, name, content_locale FROM advertiser
     WHERE tenant_id = $1
     ORDER BY created_at ASC`,
    [auth.session.tenantId],
  );
  return NextResponse.json({
    advertisers: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      contentLocale: row.content_locale,
    })),
  });
}
