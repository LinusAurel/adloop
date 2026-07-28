import { z } from "zod";
import {
  type CorrelationId,
  type GenerationRequest,
  type GenerationResult,
  type GeneratedImage,
  type ImageProvider,
  type ProviderJob,
  ProviderError,
} from "../provider";

/**
 * OpenAI Images adapter (`POST /v1/images/generations`).
 *
 * recovery: unprotected — the API accepts `Idempotency-Key` without error but
 * ignores it. Two identical requests with the same key yield two different
 * images (verified 29.07.2026; see DECISIONS.md). Response is synchronous:
 * no queue, no request_id, nothing to look up after a crash.
 */

const OpenAiUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative(),
  input_tokens_details: z
    .object({
      image_tokens: z.number().int().nonnegative().optional(),
      text_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  output_tokens_details: z
    .object({
      image_tokens: z.number().int().nonnegative().optional(),
      text_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const OpenAiImagesResponseSchema = z.object({
  created: z.number().int().positive(),
  background: z.string().optional(),
  data: z
    .array(
      z.object({
        b64_json: z.string().min(1).optional(),
        url: z.string().url().optional(),
        revised_prompt: z.string().optional(),
      }),
    )
    .min(1),
  output_format: z.string().optional(),
  quality: z.string().optional(),
  size: z.string().optional(),
  usage: OpenAiUsageSchema.optional(),
});

export type OpenAiImagesResponse = z.infer<typeof OpenAiImagesResponseSchema>;

export interface OpenAiImagesHttp {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface OpenAiImagesProviderOptions {
  apiKey: string;
  /** Override for tests / fixtures. Default: https://api.openai.com/v1/images/generations */
  baseUrl?: string;
  http?: OpenAiImagesHttp;
}

export const OPENAI_IMAGES_UNPROTECTED_REASON =
  "Idempotency-Key akzeptiert aber wirkungslos — zwei Aufrufe, zwei Bilder (4e29446e6e3c0805 / f9ed52768e9b159b), Stand 29.07.2026";

/** Expected total_tokens for a medium 1024 gpt-image-1 call (from live capture). */
export const OPENAI_IMAGES_TOKEN_ESTIMATE = 1077;
/** Approximate USD per token for cost_estimate.image (output-image-token class). */
export const OPENAI_IMAGES_USD_PER_TOKEN = 40 / 1_000_000;

export class OpenAiImagesProvider implements ImageProvider {
  readonly id = "openai-images";
  readonly models = ["gpt-image-1"] as const;
  readonly recovery = {
    kind: "unprotected" as const,
    reason: OPENAI_IMAGES_UNPROTECTED_REASON,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: OpenAiImagesHttp;
  private readonly byExternal = new Map<string, GenerationResult>();

  constructor(options: OpenAiImagesProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl =
      options.baseUrl ?? "https://api.openai.com/v1/images/generations";
    this.http = options.http ?? { fetch: globalThis.fetch.bind(globalThis) };
  }

  async submit(req: GenerationRequest, corr: CorrelationId): Promise<ProviderJob> {
    const size = aspectToOpenAiSize(req.aspectRatio);
    const response = await this.http.fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        // Sent deliberately: the header is accepted and ignored (unprotected).
        "Idempotency-Key": corr,
      },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        n: req.count,
        size,
        quality: "medium",
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        "openai_images_submit_failed",
        `openai images HTTP ${response.status}`,
      );
    }
    const raw: unknown = await response.json();
    const parsed = OpenAiImagesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError("openai_images_invalid", parsed.error.message);
    }
    const result = this.materializeParsed(parsed.data, raw);
    const externalId = `openai-${String(parsed.data.created)}`;
    this.byExternal.set(externalId, result);
    return { externalId, correlationId: corr, raw };
  }

  async fetchResult(job: ProviderJob, signal: AbortSignal): Promise<GenerationResult> {
    if (signal.aborted) throw new Error("aborted");
    const cached = this.byExternal.get(job.externalId);
    if (cached) return cached;
    // Synchronous API — nothing to poll. If the in-memory result is gone
    // (process crash), recovery is unprotected and must not call again.
    throw new ProviderError(
      "openai_images_result_missing",
      "sync response was not retained; cannot look up after crash",
    );
  }

  // No recover — unprotected. Layer must not auto-retry after crash.

  private materializeParsed(
    data: OpenAiImagesResponse,
    raw: unknown,
  ): GenerationResult {
    const dims = parseSize(data.size) ?? { width: 1024, height: 1024 };
    const mime = mimeFromFormat(data.output_format);
    const images: GeneratedImage[] = data.data.map((img) => {
      if (!img.b64_json && !img.url) {
        throw new ProviderError(
          "openai_images_empty",
          "image missing b64_json and url",
        );
      }
      return {
        bytesBase64: img.b64_json ?? Buffer.from(img.url ?? "").toString("base64"),
        mime,
        width: dims.width,
        height: dims.height,
      };
    });
    return { images, providerResponse: raw };
  }
}

function aspectToOpenAiSize(aspect: GenerationRequest["aspectRatio"]): string {
  switch (aspect) {
    case "1:1":
      return "1024x1024";
    case "4:5":
    case "9:16":
      return "1024x1536";
    case "16:9":
      return "1536x1024";
    default: {
      const _exhaustive: never = aspect;
      return _exhaustive;
    }
  }
}

function parseSize(size: string | undefined): { width: number; height: number } | null {
  if (!size) return null;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function mimeFromFormat(format: string | undefined): string {
  switch (format) {
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}
