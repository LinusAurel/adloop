import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { getObjectStore } from "@/storage/object-store";
import { AspectRatioSchema } from "@/images/provider";

const QuerySchema = z.object({
  advertiserId: z.string().uuid().optional(),
  aspectRatio: AspectRatioSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = QuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const result = await pool.query<{
    id: string;
    advertiser_id: string;
    name: string;
    primary_text: string;
    headline: string;
    description: string;
    call_to_action: string;
    asset_id: string;
    storage_key: string;
    aspect_ratio: string;
    status: string;
    generation_id: string | null;
    created_at: string;
  }>(
    `SELECT c.id, c.advertiser_id, c.name, c.primary_text, c.headline,
            c.description, c.call_to_action, c.asset_id, a.storage_key,
            c.aspect_ratio, c.status, c.generation_id, c.created_at
     FROM creative c
     JOIN asset a ON a.id = c.asset_id AND a.tenant_id = c.tenant_id
     WHERE c.tenant_id = $1
       AND ($2::uuid IS NULL OR c.advertiser_id = $2)
       AND ($3::text IS NULL OR c.aspect_ratio = $3)
     ORDER BY c.created_at DESC
     LIMIT $4`,
    [
      auth.session.tenantId,
      parsed.data.advertiserId ?? null,
      parsed.data.aspectRatio ?? null,
      parsed.data.limit,
    ],
  );

  const store = getObjectStore();
  const creatives = await Promise.all(
    result.rows.map(async (row) => {
      let previewUrl: string | null = null;
      try {
        previewUrl = await store.getSignedUrl(row.storage_key, 300);
      } catch {
        previewUrl = null;
      }
      return {
        id: row.id,
        advertiserId: row.advertiser_id,
        name: row.name,
        primaryText: row.primary_text,
        headline: row.headline,
        description: row.description,
        callToAction: row.call_to_action,
        assetId: row.asset_id,
        aspectRatio: row.aspect_ratio,
        status: row.status,
        generationId: row.generation_id,
        createdAt: row.created_at,
        previewUrl,
      };
    }),
  );

  return NextResponse.json({ creatives });
}
