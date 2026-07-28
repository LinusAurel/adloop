import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import { errorResponse } from "@/lib/api-error";
import {
  completeIdempotencyKey,
  type IdempotencyRow,
} from "@/images/idempotency";
import {
  GenerationResultSchema,
  type GenerationResult,
} from "@/images/provider";
import { getImageProvider } from "@/images/registry";
import { FalImageProvider } from "@/images/providers/fal";

const ParamsSchema = z.object({
  correlationId: z.string().uuid(),
});

const FalWebhookBodySchema = z.object({
  request_id: z.string().optional(),
  status: z.string().optional(),
  payload: z.unknown().optional(),
  // Fixture / simplified shape
  images: z
    .array(
      z.object({
        bytesBase64: z.string().optional(),
        url: z.string().optional(),
        content_type: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
    )
    .optional(),
});

/**
 * Fal correlated_callback endpoint. Correlation id is in the URL so the
 * result finds us even when we never persisted fal's request_id.
 * Fal retries up to ~10 times / 2h — this handler is itself idempotent.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ correlationId: string }> },
): Promise<NextResponse> {
  const rawParams = await context.params;
  const params = ParamsSchema.safeParse(rawParams);
  if (!params.success) return errorResponse(400, "validation_error");

  const rawBody = await request.text();
  if (env.FAL_WEBHOOK_SECRET) {
    const signature = request.headers.get("x-fal-webhook-signature") ?? "";
    const expected = createHmac("sha256", env.FAL_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return errorResponse(401, "invalid_signature");
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, "validation_error");
  }
  const parsed = FalWebhookBodySchema.safeParse(json);
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const keyRow = await pool.query<IdempotencyRow>(
    `SELECT * FROM idempotency_key WHERE correlation_id = $1`,
    [params.data.correlationId],
  );
  const row = keyRow.rows[0];
  if (!row) {
    // Unknown correlation — acknowledge so Fal stops retrying forever.
    return NextResponse.json({ ok: true, statusCode: "unknown_correlation" });
  }

  if (row.status === "succeeded") {
    // Idempotent replay of the webhook.
    return NextResponse.json({ ok: true, statusCode: "already_succeeded" });
  }

  const result = materializeWebhookResult(parsed.data);
  if (!result) return errorResponse(400, "validation_error");

  await completeIdempotencyKey(pool, { key: row.key, result });

  // Plant into live fal provider instance when available (in-process recover).
  try {
    const provider = getImageProvider("fal");
    if (provider instanceof FalImageProvider) {
      provider.acceptWebhookResult(params.data.correlationId, result);
    }
  } catch {
    // No fal key configured — DB write above is enough for recover().
  }

  return NextResponse.json({ ok: true, statusCode: "accepted" });
}

function materializeWebhookResult(
  body: z.infer<typeof FalWebhookBodySchema>,
): GenerationResult | null {
  const imagesSource =
    body.images ??
    (typeof body.payload === "object" &&
    body.payload !== null &&
    "images" in body.payload &&
    Array.isArray((body.payload as { images: unknown }).images)
      ? ((body.payload as { images: Array<Record<string, unknown>> }).images as Array<{
          bytesBase64?: string;
          url?: string;
          content_type?: string;
          width?: number;
          height?: number;
        }>)
      : null);

  if (!imagesSource || imagesSource.length === 0) return null;

  const images = imagesSource.map((img) => ({
    bytesBase64:
      img.bytesBase64 ??
      Buffer.from(img.url ?? "fal-placeholder").toString("base64"),
    mime: img.content_type ?? "image/png",
    width: img.width ?? 1080,
    height: img.height ?? 1350,
  }));

  const parsed = GenerationResultSchema.safeParse({
    images,
    providerResponse: body,
  });
  return parsed.success ? parsed.data : null;
}
