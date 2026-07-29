import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const pool = getPool();
  const projects = await pool.query(
    `SELECT id, name, archived, created_at
     FROM project
     WHERE tenant_id = $1
     ORDER BY created_at ASC`,
    [auth.session.tenantId],
  );
  return NextResponse.json({ projects: projects.rows });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");
  const pool = getPool();
  const id = uuidv7();
  await pool.query(
    `INSERT INTO project (id, tenant_id, name) VALUES ($1, $2, $3)`,
    [id, auth.session.tenantId, parsed.data.name],
  );
  return NextResponse.json({ id, name: parsed.data.name }, { status: 201 });
}
