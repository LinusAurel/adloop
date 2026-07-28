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

/**
 * ElevenLabs Image & Video adapter.
 *
 * recovery: unprotected — as of 28.07.2026 no public API contract with
 * submit + client idempotency key or result lookup could be verified
 * (see DECISIONS.md). The adapter is still built and fixture-tested so a
 * later key can flip the classification without rewriting the workshop.
 */

const ElevenSubmitResponseSchema = z.object({
  job_id: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  status: z.string().optional(),
});

const ElevenImageSchema = z.object({
  bytesBase64: z.string().optional(),
  url: z.string().url().optional(),
  mime_type: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

const ElevenResultSchema = z.object({
  images: z.array(ElevenImageSchema).min(1),
});

export interface ElevenLabsHttp {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface ElevenLabsProviderOptions {
  apiKey: string;
  baseUrl?: string;
  http?: ElevenLabsHttp;
  fixtureResults?: Map<string, unknown>;
}

export const ELEVENLABS_UNPROTECTED_REASON =
  "API-Vertrag nicht belegt, Stand 28.07.2026";

export class ElevenLabsImageProvider implements ImageProvider {
  readonly id = "elevenlabs";
  readonly models = [
    "nanobanana",
    "flux-kontext",
    "gpt-image",
    "seedream",
  ] as const;
  readonly recovery = {
    kind: "unprotected" as const,
    reason: ELEVENLABS_UNPROTECTED_REASON,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: ElevenLabsHttp;
  private readonly fixtureResults?: Map<string, unknown>;
  private readonly byExternal = new Map<string, GenerationResult>();

  constructor(options: ElevenLabsProviderOptions) {
    this.apiKey = options.apiKey;
    // Provisional endpoint shape — corrected once a real contract exists.
    this.baseUrl = options.baseUrl ?? "https://api.elevenlabs.io/v1/image-generation";
    this.http = options.http ?? { fetch: globalThis.fetch.bind(globalThis) };
    this.fixtureResults = options.fixtureResults;
  }

  async submit(req: GenerationRequest, corr: CorrelationId): Promise<ProviderJob> {
    const response = await this.http.fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "Content-Type": "application/json",
        // Correlation is sent for future recoverability; not part of a
        // verified contract today.
        "X-Correlation-Id": corr,
      },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        aspect_ratio: req.aspectRatio,
        n: req.count,
        correlation_id: corr,
      }),
    });
    if (!response.ok) {
      throw new ProviderError(
        "elevenlabs_submit_failed",
        `elevenlabs submit HTTP ${response.status}`,
      );
    }
    const raw: unknown = await response.json();
    const parsed = ElevenSubmitResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError("elevenlabs_submit_invalid", parsed.error.message);
    }
    const externalId = parsed.data.job_id ?? parsed.data.id;
    if (!externalId) {
      throw new ProviderError("elevenlabs_submit_missing_id", "no job id in response");
    }
    return { externalId, correlationId: corr, raw };
  }

  async fetchResult(job: ProviderJob, signal: AbortSignal): Promise<GenerationResult> {
    if (signal.aborted) throw new Error("aborted");
    const cached = this.byExternal.get(job.externalId);
    if (cached) return cached;

    if (this.fixtureResults?.has(job.externalId)) {
      return this.materialize(this.fixtureResults.get(job.externalId), job);
    }

    const response = await this.http.fetch(`${this.baseUrl}/${job.externalId}`, {
      headers: { "xi-api-key": this.apiKey },
      signal,
    });
    if (!response.ok) {
      throw new ProviderError(
        "elevenlabs_result_failed",
        `HTTP ${response.status}`,
      );
    }
    const raw: unknown = await response.json();
    return this.materialize(raw, job);
  }

  // No recover — unprotected. Layer must not auto-retry after crash.
  // recover is intentionally absent.

  private materialize(raw: unknown, job: ProviderJob): GenerationResult {
    const parsed = ElevenResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError("elevenlabs_result_invalid", parsed.error.message);
    }
    const dims = ASPECT_DIMENSIONS["4:5"];
    const images: GeneratedImage[] = parsed.data.images.map((img) => {
      if (!img.bytesBase64 && !img.url) {
        throw new ProviderError("elevenlabs_image_empty", "image missing bytes and url");
      }
      return {
        bytesBase64: img.bytesBase64 ?? Buffer.from(img.url ?? "").toString("base64"),
        mime: img.mime_type ?? "image/png",
        width: img.width ?? dims.width,
        height: img.height ?? dims.height,
      };
    });
    const result: GenerationResult = { images, providerResponse: raw };
    this.byExternal.set(job.externalId, result);
    return result;
  }
}
