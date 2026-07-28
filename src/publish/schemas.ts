import { z } from "zod";

/** Hard rule: every Meta write sets status=PAUSED. No ACTIVE anywhere. */
export const META_PUBLISH_STATUS = "PAUSED" as const;

/**
 * Agent-facing tool input. Deliberately has NO budget field and NO status
 * field — not optional, absent. Budget arrives only via human input on the
 * Launch API path before the resolved payload is sealed for Freigabe.
 */
export const PublishAgentInputSchema = z.object({
  advertiserId: z.string().uuid(),
  metaAdAccountId: z.string().uuid(),
  creativeIds: z.array(z.string().uuid()).min(1).max(20),
  campaign: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("existing"),
      existingCampaignId: z.string().min(1),
    }),
    z.object({
      mode: z.literal("new"),
      name: z.string().min(1).max(200).optional(),
      objective: z
        .enum([
          "OUTCOME_TRAFFIC",
          "OUTCOME_LEADS",
          "OUTCOME_SALES",
          "OUTCOME_ENGAGEMENT",
          "OUTCOME_AWARENESS",
        ])
        .optional(),
      budgetMode: z.enum(["CBO", "ABO"]).optional(),
    }),
  ]),
  adSet: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("existing"),
      existingAdSetId: z.string().min(1),
    }),
    z.object({
      mode: z.literal("new"),
      name: z.string().min(1).max(200).optional(),
    }),
  ]),
  /** Required when optimization goal ≠ binding; stored on publication. */
  deviationReason: z.string().min(1).max(2000).optional(),
  idempotencyKey: z.string().uuid(),
});

export type PublishAgentInput = z.infer<typeof PublishAgentInputSchema>;

/**
 * Human Launch form input. Budget is here — never in the agent schema.
 * No status field exists.
 */
export const PublishHumanInputSchema = PublishAgentInputSchema.extend({
  budget: z
    .object({
      /** Daily budget in account currency minor units (cents). */
      amount: z.number().int().positive(),
      currency: z.string().min(3).max(3).default("EUR"),
    })
    .optional(),
});

export type PublishHumanInput = z.infer<typeof PublishHumanInputSchema>;

/** Assert the request schema never grows a status / ACTIVE path. */
export function assertNoStatusInSchema(schemaJson: unknown): void {
  const text = JSON.stringify(schemaJson);
  if (/\bACTIVE\b/.test(text) || /"status"\s*:/.test(text)) {
    throw new Error("publish_schema_must_not_contain_status_or_ACTIVE");
  }
}

export const BudgetSourceSchema = z.object({
  kind: z.literal("human_input"),
  decidedBy: z.string().uuid(),
  decidedAt: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().min(3).max(3),
  /** Where Meta receives the budget. */
  level: z.enum(["campaign", "adset"]),
});

export type BudgetSource = z.infer<typeof BudgetSourceSchema>;

export const PublishStepOperationSchema = z.enum([
  "create_campaign",
  "create_adset",
  "create_creative",
  "create_ad",
]);

export type PublishStepOperation = z.infer<typeof PublishStepOperationSchema>;

export const ResolvedPublishPayloadSchema = z.object({
  advertiserId: z.string().uuid(),
  metaAdAccountId: z.string().uuid(),
  metaAdAccountExternalId: z.string().regex(/^act_\d+$/),
  creativeIds: z.array(z.string().uuid()).min(1),
  campaign: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("existing"),
      existingCampaignId: z.string().min(1),
    }),
    z.object({
      mode: z.literal("new"),
      name: z.string().min(1),
      objective: z.string().min(1),
      budgetMode: z.enum(["CBO", "ABO"]),
      /** Required by Meta — true for CBO, false for ABO. */
      isAdsetBudgetSharingEnabled: z.boolean(),
    }),
  ]),
  adSet: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("existing"),
      existingAdSetId: z.string().min(1),
    }),
    z.object({
      mode: z.literal("new"),
      name: z.string().min(1),
      optimizationGoal: z.string().min(1),
      billingEvent: z.string().min(1),
      bidStrategy: z.string().min(1),
      bidAmount: z.number().int().positive().optional(),
      targeting: z.record(z.unknown()),
      attributionSpec: z.array(
        z.object({
          event_type: z.string(),
          window_days: z.number().int().positive(),
        }),
      ),
            promotedObject: z.record(z.unknown()).optional(),
            startTime: z.string().min(1),
            dsaBeneficiary: z.string().min(1).optional(),
            dsaPayor: z.string().min(1).optional(),
          }),
  ]),
  creatives: z.array(
    z.object({
      creativeId: z.string().uuid(),
      name: z.string().min(1),
      adName: z.string().min(1),
      primaryText: z.string().min(1),
      headline: z.string().min(1),
      description: z.string(),
      callToAction: z.string().min(1),
      pageId: z.string().min(1),
      instagramActorId: z.string().optional(),
      linkUrl: z.string().url(),
      storageKey: z.string().min(1),
      mime: z.string().min(1),
    }),
  ),
  budgetSource: BudgetSourceSchema.optional(),
  budgetMode: z.enum(["CBO", "ABO"]),
  binding: z
    .object({
      id: z.string().uuid(),
      version: z.number().int().positive(),
      conversionMetricId: z.string().uuid(),
      conversionMetricVersion: z.number().int().positive(),
      optimizationGoal: z.string().min(1),
      promotedObject: z.record(z.unknown()),
      attributionSpec: z.array(z.string()),
    })
    .nullable(),
  deviationReason: z.string().optional(),
  bindingMismatch: z.boolean(),
  idempotencyKey: z.string().uuid(),
  /** Always PAUSED — sealed into the payload so the worker cannot invent ACTIVE. */
  status: z.literal(META_PUBLISH_STATUS),
});

export type ResolvedPublishPayload = z.infer<typeof ResolvedPublishPayloadSchema>;

export type PublishErrorCode =
  | "budget_required"
  | "budget_wrong_level"
  | "metric_binding_missing"
  | "metric_binding_mismatch"
  | "defaults_missing"
  | "creative_not_found"
  | "account_not_found"
  | "needs_human_review"
  | "idempotency_conflict"
  | "validation_error";

export class PublishError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    readonly params: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(code);
    this.name = "PublishError";
  }
}
