import { z } from "zod";

/** Progress is codes + params — never user-facing prose (SPEC §8.2 / auftrag §0.7). */
export const JobProgressParamsSchema = z.record(
  z.union([z.string(), z.number(), z.boolean()]),
);

export const JobProgressSchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
  params: JobProgressParamsSchema.default({}),
  percent: z.number().int().min(0).max(100),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

export const TURN_PHASES = [
  "queued",
  "claimed",
  "assembling_context",
  "invoking_model",
  "streaming",
  "harvesting_outputs",
  "finalizing",
  "completed",
  "awaiting_approval",
  "failed",
] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

export const RunEventKindSchema = z.enum([
  "turn_phase",
  "activity",
  "delta",
  "terminal",
]);
export type RunEventKind = z.infer<typeof RunEventKindSchema>;

/** Activity payloads use codes, not title/detail prose (auftrag §0.7). */
export const ActivityPayloadSchema = z.object({
  kind: z.literal("activity"),
  code: z.string().min(1),
  params: JobProgressParamsSchema.default({}),
  phase: z.string().optional(),
});
export type ActivityPayload = z.infer<typeof ActivityPayloadSchema>;

export const TurnPhasePayloadSchema = z.object({
  kind: z.literal("turn_phase"),
  phase: z.enum(TURN_PHASES),
  runId: z.string().uuid(),
  chatId: z.string().uuid().optional(),
});
export type TurnPhasePayload = z.infer<typeof TurnPhasePayloadSchema>;

export const DeltaPayloadSchema = z.object({
  kind: z.literal("delta"),
  text: z.string(),
  messageId: z.string().uuid(),
});
export type DeltaPayload = z.infer<typeof DeltaPayloadSchema>;

export const TerminalPayloadSchema = z.object({
  kind: z.literal("terminal"),
  status: z.enum(["completed", "failed", "cancelled"]),
  errorCode: z.string().optional(),
});
export type TerminalPayload = z.infer<typeof TerminalPayloadSchema>;

export const RenderArtifactFieldSchema = z.object({
  fieldId: z.string().min(1),
  label: z.string().min(1),
  value: z.string(),
});

export const RenderArtifactSchema = z.object({
  kind: z.string().min(1),
  runId: z.string().uuid().optional(),
  heading: z.string().optional(),
  fields: z.array(RenderArtifactFieldSchema).optional(),
  cards: z
    .array(
      z.object({
        id: z.string().min(1),
        fields: z.array(RenderArtifactFieldSchema),
      }),
    )
    .optional(),
});
export type RenderArtifact = z.infer<typeof RenderArtifactSchema>;

/** Etappe 4 only needs text_block; structure must already be generic. */
export const TextBlockArtifactSchema = RenderArtifactSchema.extend({
  kind: z.literal("text_block"),
  fields: z.array(RenderArtifactFieldSchema).min(1),
});
