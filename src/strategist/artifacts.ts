import { z } from "zod";

/**
 * Generic field list — the frontend renders fields without knowing semantics
 * (SPEC §4.6 / Etappe 5 acceptance for the ad table artifact).
 */
export const RenderFieldSchema = z.object({
  fieldId: z.string().min(1),
  label: z.string().min(1),
  value: z.union([z.string(), z.number(), z.null()]),
});

export const AdTableRowSchema = z.object({
  id: z.string().min(1),
  fields: z.array(RenderFieldSchema),
});

export const AdTableArtifactSchema = z.object({
  kind: z.literal("ad_table"),
  runId: z.string().uuid().optional(),
  rows: z.array(AdTableRowSchema),
});

export type AdTableArtifact = z.infer<typeof AdTableArtifactSchema>;
export type RenderField = z.infer<typeof RenderFieldSchema>;

export function adTableArtifact(params: {
  runId?: string;
  rows: Array<{ id: string; fields: RenderField[] }>;
}): AdTableArtifact {
  return AdTableArtifactSchema.parse({
    kind: "ad_table",
    ...(params.runId ? { runId: params.runId } : {}),
    rows: params.rows,
  });
}
