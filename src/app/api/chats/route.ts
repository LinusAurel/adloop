import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const projectId = request.nextUrl.searchParams.get("projectId");
  const pool = getPool();
  const chats = await pool.query(
    `SELECT id, project_id, name, summary, archived, pinned, awaiting_clarify, updated_at
     FROM chat
     WHERE tenant_id = $1
       AND ($2::uuid IS NULL OR project_id = $2)
     ORDER BY updated_at DESC`,
    [auth.session.tenantId, projectId],
  );
  return NextResponse.json({ chats: chats.rows });
}

const CreateSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200).default("New chat"),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");
  const pool = getPool();
  if (parsed.data.projectId) {
    const owned = await pool.query(
      `SELECT 1 FROM project WHERE id = $1 AND tenant_id = $2`,
      [parsed.data.projectId, auth.session.tenantId],
    );
    if (owned.rowCount !== 1) return errorResponse(404, "not_found");
  }
  const id = uuidv7();
  await pool.query(
    `INSERT INTO chat (id, tenant_id, project_id, name)
     VALUES ($1, $2, $3, $4)`,
    [id, auth.session.tenantId, parsed.data.projectId ?? null, parsed.data.name],
  );
  return NextResponse.json(
    { id, name: parsed.data.name, projectId: parsed.data.projectId ?? null },
    { status: 201 },
  );
}
