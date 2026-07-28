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
import { downloadImageBytes } from "@/images/image-download";
import { resolveImageMime } from "@/images/image-mime";

const ParamsSchema = z.object({
  correlationId: z.string().uuid(),
});

const FalImageSchema = z.object({
  bytesBase64: z.string().optional(),
  url: z.string().optional(),
  content_type: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const FalWebhookBodySchema = z.object({
  request_id: z.string().optional(),
  status: z.string().optional(),
  payload: z.unknown().optional(),
  images: z.array(FalImageSchema).optional(),
});

/**
 * Fal correlated_callback endpoint. Correlation id is in the URL so the
 * result finds us even when we never persisted fal's request_id.
 * Fal retries up to ~10 times / 2h — this handler is itself idempotent.
 *
 * Signature verification is mandatory. correlationId is a routing key, not
 * an authorization proof.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ correlationId: string }> },
): Promise<NextResponse> {
  const rawParams = await context.params;
  const params = ParamsSchema.safeParse(rawParams);
  if (!params.success) return errorResponse(400, "validation_error");

  const secret = env.FAL_WEBHOOK_SECRET;
  if (!secret) {
    return errorResponse(503, "webhook_not_configured");
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-fal-webhook-signature") ?? "";
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return errorResponse(401, "invalid_signature");
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

  let result: GenerationResult | null;
  try {
    result = await materializeWebhookResult(parsed.data);
  } catch {
    return errorResponse(400, "image_download_failed");
  }
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

export async function materializeWebhookResult(
  body: z.infer<typeof FalWebhookBodySchema>,
  http: { fetch: typeof fetch } = { fetch: globalThis.fetch.bind(globalThis) },
): Promise<GenerationResult | null> {
  const imagesSource =
    body.images ??
    (typeof body.payload === "object" &&
    body.payload !== null &&
    "images" in body.payload &&
    Array.isArray((body.payload as { images: unknown }).images)
      ? ((body.payload as { images: Array<z.infer<typeof FalImageSchema>> }).images)
      : null);

  if (!imagesSource || imagesSource.length === 0) return null;

  const images = [];
  for (const img of imagesSource) {
    if (img.bytesBase64) {
      const bytes = Buffer.from(img.bytesBase64, "base64");
      const mime = resolveImageMime(img.content_type, null, bytes);
      if (!mime) return null;
      images.push({
        bytesBase64: img.bytesBase64,
        mime,
        width: img.width ?? 1080,
        height: img.height ?? 1350,
      });
      continue;
    }
    if (!img.url || !isHttpUrl(img.url)) {
      return null;
    }
    const downloaded = await downloadImageBytes(img.url, http);
    const mime = resolveImageMime(
      img.content_type,
      downloaded.contentType,
      downloaded.bytes,
    );
    if (!mime) {
      throw new Error("image_mime_unknown");
    }
    images.push({
      bytesBase64: downloaded.bytes.toString("base64"),
      mime,
      width: img.width ?? 1080,
      height: img.height ?? 1350,
    });
  }

  const parsed = GenerationResultSchema.safeParse({
    images,
    providerResponse: body,
  });
  return parsed.success ? parsed.data : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
