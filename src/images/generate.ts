import { createHash } from "node:crypto";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import type { Queryable } from "@/db/queryable";
import { env } from "@/lib/env";
import type { ObjectStore } from "@/storage/object-store";
import { getObjectStore } from "@/storage/object-store";
import {
  AspectRatioSchema,
  type GenerationRequest,
  type GenerationResult,
} from "./provider";
import {
  buildIdempotencyKey,
  callProviderWithIdempotency,
  hashGenerationRequest,
  IdempotencyConflictError,
} from "./idempotency";
import {
  estimateCopyCostUsd,
  estimateImageCostUsd,
  getCopyGenerator,
  type AdCopy,
} from "./copy";
import { getImageProvider } from "./registry";

export const GenerationInputsSchema = z.object({
  advertiserId: z.string().uuid(),
  prompt: z.string().min(1).optional(),
  productContext: z.string().min(1).optional(),
  aspectRatio: AspectRatioSchema.optional(),
  count: z.number().int().min(1).max(10).optional(),
  model: z.string().min(1).optional(),
  provider: z.enum(["stub", "fal", "openai-images"]).optional(),
  /** Stable client identity for the idempotency key (not the run id). */
  clientRequestId: z.string().min(1),
  parentCreativeId: z.string().uuid().optional(),
  variationReason: z.string().min(1).optional(),
});
export type GenerationInputs = z.infer<typeof GenerationInputsSchema>;

export const ResolvedGenerationInputsSchema = z.object({
  advertiserId: z.string().uuid(),
  prompt: z.string().min(1),
  productContext: z.string().min(1),
  aspectRatio: AspectRatioSchema,
  count: z.number().int().min(1).max(10),
  model: z.string().min(1),
  provider: z.enum(["stub", "fal", "openai-images"]),
  clientRequestId: z.string().min(1),
  contentLocale: z.string().min(2),
  playbookVersion: z.string().nullable(),
  parentCreativeId: z.string().uuid().nullable(),
  variationReason: z.string().nullable(),
  /** Prompt after playbook / defaults — what the provider actually receives. */
  resolvedPrompt: z.string().min(1),
});
export type ResolvedGenerationInputs = z.infer<typeof ResolvedGenerationInputsSchema>;

export const CostEstimateSchema = z.object({
  image: z.number(),
  copy: z.number(),
  currency: z.literal("USD"),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

export function estimateGenerationCost(
  resolved: Pick<ResolvedGenerationInputs, "count" | "provider">,
): CostEstimate {
  return CostEstimateSchema.parse({
    image: estimateImageCostUsd(resolved.count, resolved.provider),
    copy: estimateCopyCostUsd(resolved.count),
    currency: "USD",
  });
}

const DEFAULT_PLAYBOOK_SUFFIX =
  "Clean product photography, high contrast, advertising quality, no text overlay.";

export async function resolveGenerationInputs(
  db: Queryable,
  tenantId: string,
  raw: GenerationInputs,
): Promise<ResolvedGenerationInputs> {
  const advertiser = await db.query<{ content_locale: string; name: string }>(
    `SELECT content_locale, name FROM advertiser WHERE id = $1 AND tenant_id = $2`,
    [raw.advertiserId, tenantId],
  );
  const row = advertiser.rows[0];
  if (!row) {
    throw new Error("advertiser_not_found");
  }

  const provider = resolveConfiguredProvider(raw.provider);
  const aspectRatio = raw.aspectRatio ?? "4:5";
  const count = raw.count ?? 1;
  const productContext = raw.productContext ?? row.name;
  const prompt = raw.prompt ?? `Ad creative for ${productContext}`;
  const model =
    raw.model ??
    (provider === "fal"
      ? "fal-ai/flux/schnell"
      : provider === "openai-images"
        ? "gpt-image-1"
        : "stub-v1");

  const resolvedPrompt = `${prompt.trim()}\n\n${DEFAULT_PLAYBOOK_SUFFIX}\nProduct: ${productContext}`;

  return ResolvedGenerationInputsSchema.parse({
    advertiserId: raw.advertiserId,
    prompt,
    productContext,
    aspectRatio,
    count,
    model,
    provider,
    clientRequestId: raw.clientRequestId,
    contentLocale: row.content_locale,
    playbookVersion: "workshop-defaults-v1",
    parentCreativeId: raw.parentCreativeId ?? null,
    variationReason: raw.variationReason ?? null,
    resolvedPrompt,
  });
}

export interface GenerationSuccess {
  status: "succeeded";
  generationId: string;
  creativeIds: string[];
  assetIds: string[];
  costEstimate: CostEstimate;
  provider: string;
  model: string;
  replayed: boolean;
}

export interface GenerationNeedsHuman {
  status: "needs_human_check";
  code: "provider_unprotected_crash" | "callback_timeout";
  reason: string;
  generationId: string;
  costEstimate: CostEstimate;
}

export interface GenerationAwaitingCallback {
  status: "awaiting_callback";
  deadlineAt: string;
  correlationId: string;
  costEstimate: CostEstimate;
}

export type GenerationOutcome =
  | GenerationSuccess
  | GenerationNeedsHuman
  | GenerationAwaitingCallback;

/**
 * Provider comes from server config. A client override is accepted only under
 * NODE_ENV=test and IMAGE_PROVIDER_REQUEST_ALLOWLIST. Anywhere else a mismatch
 * is `provider_not_allowed` — the client must not choose who gets billed.
 */
export class ProviderNotAllowedError extends Error {
  readonly code = "provider_not_allowed";
  constructor(requested: string, configured: string) {
    super(`provider_not_allowed:${requested}:${configured}`);
    this.name = "ProviderNotAllowedError";
  }
}

export function resolveConfiguredProvider(
  requested: GenerationInputs["provider"] | undefined,
): ResolvedGenerationInputs["provider"] {
  const configured = env.IMAGE_PROVIDER;
  if (!requested || requested === configured) {
    return configured;
  }
  if (env.NODE_ENV === "test" && isRequestProviderAllowed(requested)) {
    return requested;
  }
  throw new ProviderNotAllowedError(requested, configured);
}

function isRequestProviderAllowed(id: string): boolean {
  const raw = env.IMAGE_PROVIDER_REQUEST_ALLOWLIST;
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(id);
}

/** Deterministic asset id from (generationId, imageIndex) — resume-safe. */
export function deterministicAssetId(generationId: string, imageIndex: number): string {
  const hash = createHash("sha256")
    .update(`adloop:asset:${generationId}:${imageIndex}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function runImageGeneration(
  db: Queryable,
  params: {
    tenantId: string;
    runId: string;
    resolved: ResolvedGenerationInputs;
    inputs: GenerationInputs;
    objectStore?: ObjectStore;
    webhookBaseUrl?: string;
    signal?: AbortSignal;
  },
): Promise<GenerationOutcome> {
  const store = params.objectStore ?? getObjectStore();
  const provider = getImageProvider(params.resolved.provider);
  const costEstimate = estimateGenerationCost(params.resolved);

  const idempotencyKey = buildIdempotencyKey({
    tenantId: params.tenantId,
    operation: "image_generation",
    identity: params.resolved.clientRequestId,
  });

  // Hash covers what the provider + copy path will do — not the raw inputs.
  const requestHash = hashGenerationRequest({
    resolvedPrompt: params.resolved.resolvedPrompt,
    aspectRatio: params.resolved.aspectRatio,
    count: params.resolved.count,
    model: params.resolved.model,
    provider: params.resolved.provider,
    advertiserId: params.resolved.advertiserId,
    contentLocale: params.resolved.contentLocale,
    parentCreativeId: params.resolved.parentCreativeId,
    variationReason: params.resolved.variationReason,
  });

  // Replay short-circuit only when the expected creative count is present.
  // A partial persist (e.g. copy failed on image 2 of 3) must resume — the
  // images are already paid for.
  const priorCreatives = await db.query<{
    generation_id: string;
    id: string;
    asset_id: string;
  }>(
    `SELECT g.id AS generation_id, c.id, c.asset_id
     FROM creative_generation g
     JOIN creative c ON c.generation_id = g.id
     JOIN idempotency_key k ON k.key = g.idempotency_key
     WHERE g.idempotency_key = $1 AND g.tenant_id = $2 AND k.status = 'succeeded'
     ORDER BY c.created_at`,
    [idempotencyKey, params.tenantId],
  );
  if (priorCreatives.rows.length >= params.resolved.count) {
    return {
      status: "succeeded",
      generationId: priorCreatives.rows[0]!.generation_id,
      creativeIds: priorCreatives.rows.map((r) => r.id),
      assetIds: priorCreatives.rows.map((r) => r.asset_id),
      costEstimate,
      provider: params.resolved.provider,
      model: params.resolved.model,
      replayed: true,
    };
  }

  const existingGeneration = await db.query<{ id: string }>(
    `SELECT id FROM creative_generation
     WHERE idempotency_key = $1 AND tenant_id = $2
     ORDER BY created_at
     LIMIT 1`,
    [idempotencyKey, params.tenantId],
  );
  const resumeGenerationId = existingGeneration.rows[0]?.id ?? null;
  const alreadyPersisted = priorCreatives.rows.length;

  const providerRequest: GenerationRequest = {
    prompt: params.resolved.resolvedPrompt,
    aspectRatio: params.resolved.aspectRatio,
    count: params.resolved.count,
    model: params.resolved.model,
    webhookBaseUrl: params.webhookBaseUrl,
  };

  let callOutcome;
  try {
    callOutcome = await callProviderWithIdempotency(db, {
      key: idempotencyKey,
      tenantId: params.tenantId,
      requestHash,
      provider,
      request: providerRequest,
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) throw error;
    throw error;
  }

  if (callOutcome.kind === "awaiting_callback") {
    return {
      status: "awaiting_callback",
      deadlineAt: callOutcome.deadlineAt,
      correlationId: callOutcome.correlationId,
      costEstimate,
    };
  }

  const generationId = resumeGenerationId ?? uuidv7();

  if (!resumeGenerationId) {
    // Key now exists (reserved or completed) — safe for the FK.
    await db.query(
      `INSERT INTO creative_generation (
         id, tenant_id, run_id, advertiser_id, provider, model,
         inputs, resolved_inputs, provider_request, provider_response,
         playbook_version, cost_estimate, idempotency_key
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
         $11, $12::jsonb, $13
       )`,
      [
        generationId,
        params.tenantId,
        params.runId,
        params.resolved.advertiserId,
        params.resolved.provider,
        params.resolved.model,
        JSON.stringify(params.inputs),
        JSON.stringify(params.resolved),
        JSON.stringify(providerRequest),
        JSON.stringify(
          callOutcome.kind === "needs_human_check"
            ? { status: callOutcome.code, reason: callOutcome.reason }
            : (callOutcome.result.providerResponse ?? callOutcome.result),
        ),
        params.resolved.playbookVersion,
        JSON.stringify(costEstimate),
        idempotencyKey,
      ],
    );
  }

  if (callOutcome.kind === "needs_human_check") {
    return {
      status: "needs_human_check",
      code: callOutcome.code,
      reason: callOutcome.reason,
      generationId,
      costEstimate,
    };
  }

  const generationResult = callOutcome.result;
  const replayed = callOutcome.kind === "replay" || alreadyPersisted > 0;

  const copyGen = getCopyGenerator();
  const signal = params.signal ?? new AbortController().signal;
  const creativeIds: string[] = priorCreatives.rows.map((r) => r.id);
  const assetIds: string[] = priorCreatives.rows.map((r) => r.asset_id);

  for (let i = alreadyPersisted; i < generationResult.images.length; i += 1) {
    const image = generationResult.images[i]!;
    const bytes = Buffer.from(image.bytesBase64, "base64");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const assetId = deterministicAssetId(generationId, i);
    const storageKey = `tenants/${params.tenantId}/assets/${assetId}`;

    const existingAsset = await db.query<{ id: string }>(
      `SELECT id FROM asset WHERE id = $1 AND tenant_id = $2`,
      [assetId, params.tenantId],
    );
    if (!existingAsset.rows[0]) {
      // Insert the row before upload so a crash mid-put still yields a stable id.
      await db.query(
        `INSERT INTO asset (
           id, tenant_id, kind, storage_key, width, height, mime, checksum
         ) VALUES ($1, $2, 'image', $3, $4, $5, $6, $7)`,
        [
          assetId,
          params.tenantId,
          storageKey,
          image.width,
          image.height,
          image.mime,
          checksum,
        ],
      );
      await store.putBytes(storageKey, bytes, image.mime, signal);
    }
    // Else: asset already exists from a prior attempt (e.g. copy failed after
    // upload). Same id + storage key — do not create an orphan object.
    assetIds.push(assetId);

    const existingCreative = await db.query<{ id: string }>(
      `SELECT id FROM creative WHERE asset_id = $1 AND tenant_id = $2`,
      [assetId, params.tenantId],
    );
    if (existingCreative.rows[0]) {
      creativeIds.push(existingCreative.rows[0].id);
      continue;
    }

    const copy: AdCopy = await copyGen.generate({
      contentLocale: params.resolved.contentLocale,
      productContext: params.resolved.productContext,
      prompt: params.resolved.prompt,
      aspectRatio: params.resolved.aspectRatio,
      signal,
    });

    const creativeId = uuidv7();
    await db.query(
      `INSERT INTO creative (
         id, tenant_id, advertiser_id, name,
         primary_text, headline, description, call_to_action,
         asset_id, aspect_ratio, status, generation_id
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10, 'ready', $11
       )`,
      [
        creativeId,
        params.tenantId,
        params.resolved.advertiserId,
        `${params.resolved.productContext} #${i + 1}`,
        copy.primary_text,
        copy.headline,
        copy.description,
        copy.call_to_action,
        assetId,
        params.resolved.aspectRatio,
        generationId,
      ],
    );
    creativeIds.push(creativeId);

    if (params.resolved.parentCreativeId && params.resolved.variationReason) {
      await db.query(
        `INSERT INTO creative_variant (
           id, parent_creative_id, creative_id, variation_index, reason
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          uuidv7(),
          params.resolved.parentCreativeId,
          creativeId,
          i,
          params.resolved.variationReason,
        ],
      );
    }
  }

  return {
    status: "succeeded",
    generationId,
    creativeIds,
    assetIds,
    costEstimate,
    provider: params.resolved.provider,
    model: params.resolved.model,
    replayed,
  };
}

/** Exported for adapter-switch tests — same structure across providers. */
export function normalizeGenerationResultShape(result: GenerationResult): {
  imageCount: number;
  mimes: string[];
} {
  return {
    imageCount: result.images.length,
    mimes: result.images.map((i) => i.mime),
  };
}
