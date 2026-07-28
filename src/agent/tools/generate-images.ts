import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import { createRun } from "@/queue/create-run";
import type { ToolDefinition } from "./types";
import {
  GenerationInputsSchema,
  estimateGenerationCost,
  resolveGenerationInputs,
} from "@/images/generate";

const GenerateImagesInput = GenerationInputsSchema;

/**
 * Expensive external tool — Freigabe required. Same path the workshop UI
 * uses; there is no side door around approval (auftrag §0).
 */
export const generateImagesTool: ToolDefinition<
  z.infer<typeof GenerateImagesInput>,
  unknown
> = {
  name: "generate_images",
  version: "1",
  description:
    "Generate static ad creatives (image + copy) for an advertiser. Costs money.",
  inputSchema: GenerateImagesInput,
  kind: "async_submit",
  costClass: "expensive",
  sideEffect: "external",
  jobFamily: "image_generation",

  async resolve(raw, ctx) {
    const pool = getPool();
    const resolved = await resolveGenerationInputs(pool, ctx.tenantId, raw);
    const costEstimate = estimateGenerationCost(resolved);
    return {
      inputs: raw,
      resolved,
      costEstimate,
      webhookBaseUrl: env.PUBLIC_BASE_URL ?? undefined,
    };
  },

  async handler(resolvedPayload, ctx) {
    const payload = resolvedPayload as {
      inputs: z.infer<typeof GenerateImagesInput>;
      resolved: Awaited<ReturnType<typeof resolveGenerationInputs>>;
      costEstimate: ReturnType<typeof estimateGenerationCost>;
      webhookBaseUrl?: string;
    };
    const pool = getPool();
    const runId = uuidv7();
    const created = await createRun(pool, {
      runId,
      tenantId: ctx.tenantId,
      family: "image_generation",
      input: {
        inputs: payload.inputs,
        resolved: payload.resolved,
        webhookBaseUrl: payload.webhookBaseUrl,
      },
    });
    return {
      submittedRunId: runId,
      outcome: created.outcome,
      costEstimate: payload.costEstimate,
      provider: payload.resolved.provider,
      model: payload.resolved.model,
    };
  },
};
