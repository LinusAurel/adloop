import { z } from "zod";
import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import { HandlerError } from "../errors";
import type { JobFamilyDefinition } from "../types";
import {
  GenerationInputsSchema,
  ResolvedGenerationInputsSchema,
  runImageGeneration,
} from "@/images/generate";
import { IdempotencyConflictError } from "@/images/idempotency";
import { setCopyGeneratorForTests, StubCopyGenerator } from "@/images/copy";

const InputSchema = z.object({
  inputs: GenerationInputsSchema,
  resolved: ResolvedGenerationInputsSchema,
  webhookBaseUrl: z.string().url().optional(),
});

const ResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    generationId: z.string().uuid(),
    creativeIds: z.array(z.string().uuid()),
    assetIds: z.array(z.string().uuid()),
    costEstimate: z.object({
      image: z.number(),
      copy: z.number(),
      currency: z.literal("USD"),
    }),
    provider: z.string(),
    model: z.string(),
    replayed: z.boolean(),
  }),
  z.object({
    status: z.literal("needs_human_check"),
    code: z.literal("provider_unprotected_crash"),
    reason: z.string(),
    generationId: z.string().uuid(),
    costEstimate: z.object({
      image: z.number(),
      copy: z.number(),
      currency: z.literal("USD"),
    }),
  }),
]);

type Input = z.infer<typeof InputSchema>;
type Result = z.infer<typeof ResultSchema>;

export const imageGenerationFamily: JobFamilyDefinition<Input, Result> = {
  name: "image_generation",
  inputSchema: InputSchema,
  resultSchema: ResultSchema,
  maxAttempts: 3,
  timeoutMs: 10 * 60 * 1_000,

  async handler(ctx) {
    if (env.NODE_ENV === "test" || ctx.input.resolved.provider === "stub") {
      setCopyGeneratorForTests(new StubCopyGenerator());
    }

    const pool = getPool();

    try {
      const outcome = await runImageGeneration(pool, {
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        resolved: ctx.input.resolved,
        inputs: ctx.input.inputs,
        webhookBaseUrl: ctx.input.webhookBaseUrl ?? env.PUBLIC_BASE_URL,
        signal: ctx.signal,
      });

      if (outcome.status === "needs_human_check") {
        return outcome;
      }

      await ctx.progress({
        state: "completed",
        code: "image_generation_done",
        params: { creativeCount: outcome.creativeIds.length },
        percent: 100,
      });
      return outcome;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new HandlerError(
          "IDEMPOTENCY_HASH_CONFLICT",
          error.message,
          false,
        );
      }
      throw error;
    }
  },
};
