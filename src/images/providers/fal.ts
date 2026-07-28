import { z } from "zod";
import {
  type CorrelationId,
  type GenerationRequest,
  type GenerationResult,
  type GeneratedImage,
  type ImageProvider,
  type ProviderJob,
  ProviderError,
  ASPECT_DIMENSIONS,
} from "../provider";

const FalSubmitResponseSchema = z.object({
  request_id: z.string().min(1),
  status: z.string().optional(),
});

const FalImageSchema = z.object({
  url: z.string().url().optional(),
  content_type: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  // Fixture path: inline base64 when no network (recorded responses).
  bytesBase64: z.string().optional(),
});

const FalResultPayloadSchema = z.object({
  images: z.array(FalImageSchema).optional(),
  image: FalImageSchema.optional(),
});

export interface FalHttp {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface FalProviderOptions {
  apiKey: string;
  /** Override for tests / fixtures. Default: https://queue.fal.run */
  baseUrl?: string;
  http?: FalHttp;
  /** When set, fetchResult/recover read from this map instead of network. */
  fixtureResults?: Map<string, unknown>;
}

/**
 * Fal adapter — recovery via correlated webhook URL
 * (`https://<host>/api/webhooks/fal/<correlationId>`).
 *
 * Evidence: Fal Queue accepts `webhookUrl` / `fal_webhook` on submit but no
 * client-set idempotency key (fal.ai docs, Queue + Webhooks, Stand 28.07.2026).
 */
export class FalImageProvider implements ImageProvider {
  readonly id = "fal";
  readonly models = [
    "fal-ai/flux/schnell",
    "fal-ai/flux/dev",
    "fal-ai/nano-banana-2",
  ] as const;
  readonly recovery = { kind: "correlated_callback" as const };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: FalHttp;
  private readonly fixtureResults?: Map<string, unknown>;
  private readonly byCorrelation = new Map<string, GenerationResult>();

  constructor(options: FalProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://queue.fal.run";
    this.http = options.http ?? { fetch: globalThis.fetch.bind(globalThis) };
    this.fixtureResults = options.fixtureResults;
  }

  /** Webhook handler plants the result under our correlation id. */
  acceptWebhookResult(corr: CorrelationId, result: GenerationResult): void {
    this.byCorrelation.set(corr, result);
  }

  buildWebhookUrl(base: string, corr: CorrelationId): string {
    const trimmed = base.replace(/\/$/, "");
    return `${trimmed}/api/webhooks/fal/${corr}`;
  }

  async submit(req: GenerationRequest, corr: CorrelationId): Promise<ProviderJob> {
    if (!req.webhookBaseUrl) {
      throw new ProviderError(
        "fal_webhook_required",
        "fal correlated_callback requires webhookBaseUrl",
      );
    }
    const webhookUrl = this.buildWebhookUrl(req.webhookBaseUrl, corr);
    const endpoint = `${this.baseUrl}/${req.model}?fal_webhook=${encodeURIComponent(webhookUrl)}`;

    const response = await this.http.fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Key ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: req.prompt,
        num_images: req.count,
        image_size: aspectToFalSize(req.aspectRatio),
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        "fal_submit_failed",
        `fal submit HTTP ${response.status}`,
      );
    }
    const raw: unknown = await response.json();
    const parsed = FalSubmitResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError("fal_submit_invalid", parsed.error.message);
    }
    return {
      externalId: parsed.data.request_id,
      correlationId: corr,
      raw,
    };
  }

  async fetchResult(job: ProviderJob, signal: AbortSignal): Promise<GenerationResult> {
    if (signal.aborted) throw new Error("aborted");

    // Prefer webhook-planted / recover cache.
    const planted = this.byCorrelation.get(job.correlationId);
    if (planted) return planted;

    if (this.fixtureResults?.has(job.externalId)) {
      return await this.materialize(this.fixtureResults.get(job.externalId), job, signal);
    }

    const statusUrl = `${this.baseUrl}/requests/${job.externalId}/status`;
    const statusRes = await this.http.fetch(statusUrl, {
      headers: { Authorization: `Key ${this.apiKey}` },
      signal,
    });
    if (!statusRes.ok) {
      throw new ProviderError("fal_status_failed", `HTTP ${statusRes.status}`);
    }
    const resultUrl = `${this.baseUrl}/requests/${job.externalId}`;
    const resultRes = await this.http.fetch(resultUrl, {
      headers: { Authorization: `Key ${this.apiKey}` },
      signal,
    });
    if (!resultRes.ok) {
      throw new ProviderError("fal_result_failed", `HTTP ${resultRes.status}`);
    }
    const raw: unknown = await resultRes.json();
    return await this.materialize(raw, job, signal);
  }

  async recover(corr: CorrelationId): Promise<GenerationResult | null> {
    return this.byCorrelation.get(corr) ?? null;
  }

  private async materialize(
    raw: unknown,
    job: ProviderJob,
    signal: AbortSignal,
  ): Promise<GenerationResult> {
    const parsed = FalResultPayloadSchema.safeParse(
      typeof raw === "object" && raw !== null && "payload" in raw
        ? (raw as { payload: unknown }).payload
        : raw,
    );
    if (!parsed.success) {
      throw new ProviderError("fal_result_invalid", parsed.error.message);
    }
    const source = parsed.data.images ?? (parsed.data.image ? [parsed.data.image] : []);
    if (source.length === 0) {
      throw new ProviderError("fal_result_empty", "no images in fal payload");
    }
    const images: GeneratedImage[] = [];
    for (const img of source) {
      if (img.bytesBase64) {
        images.push({
          bytesBase64: img.bytesBase64,
          mime: img.content_type ?? "image/png",
          width: img.width ?? 1080,
          height: img.height ?? 1350,
        });
        continue;
      }
      if (!img.url) {
        throw new ProviderError("fal_image_url_missing", "image has neither url nor bytes");
      }
      const dl = await this.http.fetch(img.url, { signal });
      if (!dl.ok) {
        throw new ProviderError("fal_image_download_failed", `HTTP ${dl.status}`);
      }
      const buf = Buffer.from(await dl.arrayBuffer());
      images.push({
        bytesBase64: buf.toString("base64"),
        mime: img.content_type ?? dl.headers.get("content-type") ?? "image/png",
        width: img.width ?? 1080,
        height: img.height ?? 1350,
      });
    }
    const result: GenerationResult = { images, providerResponse: raw };
    this.byCorrelation.set(job.correlationId, result);
    return result;
  }
}

function aspectToFalSize(aspect: GenerationRequest["aspectRatio"]): string {
  const dims = ASPECT_DIMENSIONS[aspect];
  return `${dims.width}x${dims.height}`;
}
