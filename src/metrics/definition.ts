import { z } from "zod";
import { assertSumDisjointAllowed, MetricConfigError } from "./action-overlaps";
import type {
  ConfiguredBy,
  DenominatorField,
  NumeratorAggregation,
  ValueSource,
} from "./types";
import { SYNCED_ATTRIBUTION_SPEC } from "./types";

export const MetricDefinitionInfoSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  label: z.string().min(1),
  numeratorActionTypes: z.array(z.string().min(1)).min(1),
  numeratorAggregation: z.enum([
    "sum_disjoint",
    "coalesce_aliases",
    "first_present",
  ]),
  attributionSpec: z.array(z.string().min(1)).min(1),
  denominator: z
    .enum(["impressions", "clicks", "link_clicks", "landing_page_views"])
    .nullable(),
  valueSource: z.enum(["meta_value", "fixed", "none"]),
  fixedValue: z.number().finite().nullable(),
  currency: z.string().nullable(),
  configuredBy: z.enum(["user", "default", "fallback"]),
});

export type MetricDefinitionInfo = z.infer<typeof MetricDefinitionInfoSchema>;

export const CreateConversionMetricSchema = z
  .object({
    label: z.string().min(1).max(200),
    numeratorActionTypes: z.array(z.string().min(1)).min(1),
    numeratorAggregation: z.enum([
      "sum_disjoint",
      "coalesce_aliases",
      "first_present",
    ]),
    attributionSpec: z
      .array(z.string().min(1))
      .min(1)
      .default([...SYNCED_ATTRIBUTION_SPEC]),
    denominator: z
      .enum(["impressions", "clicks", "link_clicks", "landing_page_views"])
      .nullable()
      .default(null),
    valueSource: z.enum(["meta_value", "fixed", "none"]),
    fixedValue: z.number().finite().nullable().optional(),
    currency: z.string().min(1).nullable().optional(),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.numeratorActionTypes).size !==
      value.numeratorActionTypes.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate_action_types",
        path: ["numeratorActionTypes"],
      });
    }
    if (value.numeratorAggregation === "sum_disjoint") {
      try {
        assertSumDisjointAllowed(value.numeratorActionTypes);
      } catch (error) {
        if (error instanceof MetricConfigError) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: error.code,
            path: ["numeratorActionTypes"],
          });
        } else {
          throw error;
        }
      }
    }
    if (value.valueSource === "fixed") {
      if (value.fixedValue === null || value.fixedValue === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "fixed_value_required",
          path: ["fixedValue"],
        });
      }
      if (!value.currency) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "currency_required",
          path: ["currency"],
        });
      }
    }
  });

export type CreateConversionMetricInput = z.input<
  typeof CreateConversionMetricSchema
>;
export type CreateConversionMetricParsed = z.infer<
  typeof CreateConversionMetricSchema
>;

/** Well-known fallback used when no assignment exists for the account. */
export const FALLBACK_PURCHASE_METRIC: MetricDefinitionInfo = {
  id: "00000000-0000-0000-0000-0000000000f1",
  version: 1,
  label: "Purchase",
  numeratorActionTypes: [
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "purchase",
  ],
  numeratorAggregation: "coalesce_aliases",
  attributionSpec: [...SYNCED_ATTRIBUTION_SPEC],
  denominator: "link_clicks",
  valueSource: "meta_value",
  fixedValue: null,
  currency: null,
  configuredBy: "fallback",
};

export function canonicalizeAttributionSpec(
  values: readonly string[],
): string[] {
  return [...new Set(values)].sort();
}

export interface StoredMetricRow {
  id: string;
  version: number;
  label: string;
  numerator_action_types: string[];
  numerator_aggregation: NumeratorAggregation;
  attribution_spec: string[];
  denominator: DenominatorField | null;
  value_source: ValueSource;
  fixed_value: string | null;
  currency: string | null;
}

export function toMetricDefinitionInfo(
  row: StoredMetricRow,
  configuredBy: ConfiguredBy,
): MetricDefinitionInfo {
  return MetricDefinitionInfoSchema.parse({
    id: row.id,
    version: row.version,
    label: row.label,
    numeratorActionTypes: row.numerator_action_types,
    numeratorAggregation: row.numerator_aggregation,
    attributionSpec: row.attribution_spec,
    denominator: row.denominator,
    valueSource: row.value_source,
    fixedValue: row.fixed_value === null ? null : Number(row.fixed_value),
    currency: row.currency,
    configuredBy,
  });
}
