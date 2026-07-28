import { AgentTurnInputSchema, agentTurnFamily } from "@/agent/turn";
import type { JobFamilyDefinition } from "@/queue/types";
import { z } from "zod";

type Input = z.infer<typeof AgentTurnInputSchema>;
type Result = Awaited<ReturnType<typeof agentTurnFamily.handler>>;

/**
 * Strategist review families share the agent-turn handler. Distinct names give
 * per-type concurrency limits and independent timeout/attempt budgets.
 */
function reviewFamily(
  name: "copychief_review" | "cro_review" | "variations",
  opts: { timeoutMs: number; maxAttempts: number },
): JobFamilyDefinition<Input, Result> {
  return {
    name,
    inputSchema: AgentTurnInputSchema,
    resultSchema: agentTurnFamily.resultSchema,
    maxAttempts: opts.maxAttempts,
    timeoutMs: opts.timeoutMs,
    handler: agentTurnFamily.handler,
  };
}

export const copychiefReviewFamily = reviewFamily("copychief_review", {
  timeoutMs: 12 * 60 * 1000,
  maxAttempts: 2,
});

export const croReviewFamily = reviewFamily("cro_review", {
  timeoutMs: 12 * 60 * 1000,
  maxAttempts: 2,
});

export const variationsFamily = reviewFamily("variations", {
  timeoutMs: 15 * 60 * 1000,
  maxAttempts: 2,
});

export const STRATEGIST_RUN_TYPES = [
  "copychief_review",
  "cro_review",
  "variations",
] as const;

export type StrategistRunType = (typeof STRATEGIST_RUN_TYPES)[number];

export const MODE_TO_RUN_TYPE = {
  copychief: "copychief_review",
  cro: "cro_review",
  variations: "variations",
} as const satisfies Record<string, StrategistRunType>;

export const MODE_TO_PLAYBOOK = {
  copychief: "copychief",
  cro: "cro",
  variations: "variations",
} as const;

/** i18n keys for system-generated chat titles (UI translates; no prose here). */
export const MODE_TITLE_CODE = {
  copychief: "strategist.copychief_review_title",
  cro: "strategist.cro_review_title",
  variations: "strategist.variations_title",
} as const;

/** i18n keys for the visible user message that starts a review. */
export const MODE_REQUEST_CODE = {
  copychief: "strategist.copychief_review_request",
  cro: "strategist.cro_review_request",
  variations: "strategist.variations_request",
} as const;
