import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";
import {
  ASPECT_DIMENSIONS,
  type CorrelationId,
  type GenerationRequest,
  type GenerationResult,
  type ImageProvider,
  type ProviderJob,
  type ProviderRecovery,
} from "../provider";

export type StubRecoveryKind = ProviderRecovery["kind"];

export interface StubProviderOptions {
  recovery?: ProviderRecovery;
  /** Called after a successful submit returns — inject crash here in tests. */
  afterSubmitHook?: (job: ProviderJob) => void | Promise<void>;
  /** Deterministic seed for placeholder bytes. */
  seed?: string;
}

/**
 * Offline provider. Configurable for every recovery kind so the idempotency
 * layer is proven without network keys (auftrag §0).
 */
export class StubImageProvider implements ImageProvider {
  readonly id = "stub";
  readonly models = ["stub-v1"] as const;
  readonly recovery: ProviderRecovery;

  private readonly afterSubmitHook?: StubProviderOptions["afterSubmitHook"];
  private readonly seed: string;
  private submitCount = 0;
  private readonly byCorrelation = new Map<string, GenerationResult>();
  private readonly jobs = new Map<string, { corr: CorrelationId; req: GenerationRequest }>();

  constructor(options: StubProviderOptions = {}) {
    this.recovery = options.recovery ?? { kind: "native_key" };
    this.afterSubmitHook = options.afterSubmitHook;
    this.seed = options.seed ?? "stub";
  }

  getSubmitCount(): number {
    return this.submitCount;
  }

  /** Test helper: plant a result under a correlation id (callback / lookup). */
  plantResult(corr: CorrelationId, result: GenerationResult): void {
    this.byCorrelation.set(corr, result);
  }

  async submit(req: GenerationRequest, corr: CorrelationId): Promise<ProviderJob> {
    this.submitCount += 1;
    const externalId = `stub-${corr}`;
    this.jobs.set(externalId, { corr, req });

    // native_key: same correlation re-submit returns the same logical job
    // without inventing a second billable call — we still count submit for
    // observability, but recover() / fetchResult share the planted result.
    if (this.recovery.kind === "native_key" && this.byCorrelation.has(corr)) {
      const job: ProviderJob = { externalId, correlationId: corr };
      if (this.afterSubmitHook) await this.afterSubmitHook(job);
      return job;
    }

    const result = buildStubResult(req, this.seed, corr);
    this.byCorrelation.set(corr, result);

    const job: ProviderJob = {
      externalId,
      correlationId: corr,
      raw: { accepted: true },
    };
    if (this.afterSubmitHook) await this.afterSubmitHook(job);
    return job;
  }

  async fetchResult(job: ProviderJob, signal: AbortSignal): Promise<GenerationResult> {
    if (signal.aborted) throw new Error("aborted");
    const found = this.byCorrelation.get(job.correlationId);
    if (!found) throw new Error(`stub_result_missing:${job.correlationId}`);
    return found;
  }

  async recover(corr: CorrelationId): Promise<GenerationResult | null> {
    if (this.recovery.kind === "unprotected") return null;
    return this.byCorrelation.get(corr) ?? null;
  }
}

function buildStubResult(
  req: GenerationRequest,
  seed: string,
  corr: string,
): GenerationResult {
  const dims = ASPECT_DIMENSIONS[req.aspectRatio];
  const images = Array.from({ length: req.count }, (_, index) => {
    const payload = `${seed}|${corr}|${req.prompt}|${index}|${req.model}`;
    const hash = createHash("sha256").update(payload).digest();
    // Tiny deterministic PNG-like placeholder (not a real PNG — tests treat as bytes).
    const bytes = Buffer.concat([
      Buffer.from("STUBIMG1"),
      hash,
      Buffer.from(`${dims.width}x${dims.height}`),
    ]);
    return {
      bytesBase64: bytes.toString("base64"),
      mime: "image/png",
      width: dims.width,
      height: dims.height,
    };
  });
  return {
    images,
    providerResponse: { provider: "stub", correlationId: corr, model: req.model },
  };
}

/** Fresh correlation id for a generation attempt. */
export function newCorrelationId(): CorrelationId {
  return uuidv7();
}
