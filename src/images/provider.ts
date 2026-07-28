import { z } from "zod";

export const AspectRatioSchema = z.enum(["1:1", "4:5", "9:16", "16:9"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const CorrelationIdSchema = z.string().uuid();
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

export const ProviderRecoverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native_key") }),
  z.object({ kind: z.literal("correlated_callback") }),
  z.object({ kind: z.literal("lookup_by_correlation") }),
  z.object({ kind: z.literal("unprotected"), reason: z.string().min(1) }),
]);
export type ProviderRecovery = z.infer<typeof ProviderRecoverySchema>;

export const GenerationRequestSchema = z.object({
  prompt: z.string().min(1),
  aspectRatio: AspectRatioSchema,
  count: z.number().int().min(1).max(10),
  model: z.string().min(1),
  /** Absolute webhook base for correlated_callback providers (fal). */
  webhookBaseUrl: z.string().url().optional(),
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

export const ProviderJobSchema = z.object({
  externalId: z.string().min(1),
  correlationId: CorrelationIdSchema,
  raw: z.unknown().optional(),
});
export type ProviderJob = z.infer<typeof ProviderJobSchema>;

export const GeneratedImageSchema = z.object({
  bytesBase64: z.string().min(1),
  mime: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type GeneratedImage = z.infer<typeof GeneratedImageSchema>;

export const GenerationResultSchema = z.object({
  images: z.array(GeneratedImageSchema).min(1),
  providerResponse: z.unknown().optional(),
});
export type GenerationResult = z.infer<typeof GenerationResultSchema>;

/**
 * Exchangeable image provider (auftrag §0). Forks swap adapters; the workshop
 * does not care which one is configured.
 */
export interface ImageProvider {
  readonly id: string;
  readonly models: readonly string[];
  /** How this provider closes the crash window after accept-before-persist. */
  readonly recovery: ProviderRecovery;
  submit(req: GenerationRequest, corr: CorrelationId): Promise<ProviderJob>;
  fetchResult(job: ProviderJob, signal: AbortSignal): Promise<GenerationResult>;
  /** After a crash: did anything land under our correlation id? */
  recover?(corr: CorrelationId): Promise<GenerationResult | null>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
};
