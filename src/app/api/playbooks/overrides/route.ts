import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { evaluateAccessPolicy } from "@/access/policy";
import { authenticate } from "@/auth/guard";
import { hashPlaybookFiles } from "@/lib/canonical-json";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { env } from "@/lib/env";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
async function requireEditPlaybooks(
  request: NextRequest,
): Promise<
  | { ok: true; session: { userId: string; tenantId: string } }
  | { ok: false; response: NextResponse }
> {
  const auth = authenticate(request);
  if (!auth.ok) return auth;
  const pool = getPool();
  const user = await pool.query<{ role: string }>(
    `SELECT role FROM app_user WHERE id = $1 AND tenant_id = $2`,
    [auth.session.userId, auth.session.tenantId],
  );
  const policy = evaluateAccessPolicy(user.rows[0]?.role ?? "");
  if (!policy.actions.editPlaybooks) {
    return { ok: false, response: errorResponse(403, "forbidden") };
  }
  return { ok: true, session: auth.session };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireEditPlaybooks(request);
  if (!auth.ok) return auth.response;
  const pool = getPool();
  const rows = await pool.query(
    `SELECT id, playbook_slug, version, content_hash, active, created_at
     FROM playbook_override
     WHERE tenant_id = $1
     ORDER BY playbook_slug, version DESC`,
    [auth.session.tenantId],
  );
  return NextResponse.json({ overrides: rows.rows });
}

const UpsertSchema = z.object({
  playbookSlug: z.string().min(1).max(100),
  files: z
    .record(z.string())
    .refine((f) => typeof f["PLAYBOOK.md"] === "string"),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireEditPlaybooks(request);
  if (!auth.ok) return auth.response;
  const parsed = UpsertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const contentHash = hashPlaybookFiles(parsed.data.files);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE playbook_override SET active = false
       WHERE tenant_id = $1 AND playbook_slug = $2 AND active = true`,
      [auth.session.tenantId, parsed.data.playbookSlug],
    );
    const versionResult = await client.query<{ max: number | null }>(
      `SELECT MAX(version) AS max FROM playbook_override
       WHERE tenant_id = $1 AND playbook_slug = $2`,
      [auth.session.tenantId, parsed.data.playbookSlug],
    );
    const version = (versionResult.rows[0]?.max ?? 0) + 1;
    const id = uuidv7();
    await client.query(
      `INSERT INTO playbook_override (
         id, tenant_id, playbook_slug, version, files, content_hash, author_id, active
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, true)`,
      [
        id,
        auth.session.tenantId,
        parsed.data.playbookSlug,
        version,
        JSON.stringify(parsed.data.files),
        contentHash,
        auth.session.userId,
      ],
    );
    await client.query("COMMIT");
    return NextResponse.json({ id, version, contentHash }, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const ResetSchema = z.object({
  playbookSlug: z.string().min(1),
});

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await requireEditPlaybooks(request);
  if (!auth.ok) return auth.response;
  const parsed = ResetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");
  const pool = getPool();
  await pool.query(
    `UPDATE playbook_override SET active = false
     WHERE tenant_id = $1 AND playbook_slug = $2 AND active = true`,
    [auth.session.tenantId, parsed.data.playbookSlug],
  );
  return NextResponse.json({ ok: true });
}

/** Export is off by default — enables only with PLAYBOOK_EXPORT_ENABLED=true. */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = await requireEditPlaybooks(request);
  if (!auth.ok) return auth.response;
  if (process.env.PLAYBOOK_EXPORT_ENABLED !== "true") {
    return errorResponse(403, "export_disabled");
  }
  void env;
  const body = z
    .object({ playbookSlug: z.string().min(1) })
    .safeParse(await request.json().catch(() => null));
  if (!body.success) return errorResponse(400, "validation_error");
  const pool = getPool();
  const row = await pool.query<{ files: Record<string, string> }>(
    `SELECT files FROM playbook_override
     WHERE tenant_id = $1 AND playbook_slug = $2 AND active = true`,
    [auth.session.tenantId, body.data.playbookSlug],
  );
  if (!row.rows[0]) return errorResponse(404, "not_found");
  return NextResponse.json({ files: row.rows[0].files });
}
