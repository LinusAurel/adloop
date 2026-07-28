import { z } from "zod";
import type { GateReason, ValueSource } from "./types";
import { SYNCED_ATTRIBUTION_SPEC } from "./types";

export const RoasResultSchema = z.object({
  value: z.number().finite().nullable(),
  reason: z
    .enum(["no_spend", "currency_mismatch", "missing_meta_value", "value_source_none"])
    .optional(),
  valueSource: z.enum(["meta_value", "fixed", "none"]),
  currency: z.string().nullable(),
  attributionSpec: z.array(z.string()),
  dataAsOf: z.string().datetime({ offset: true }),
});

export type RoasResult = z.infer<typeof RoasResultSchema>;

export interface ComputeRoasInput {
  spend: number;
  metaValue: number | null;
  numeratorCount: number | null;
  valueSource: ValueSource;
  fixedValue: number | null;
  fixedCurrency: string | null;
  accountCurrency: string;
  attributionSpec: readonly string[];
  dataAsOf: Date;
}

function base(
  input: ComputeRoasInput,
  valueSource: ValueSource,
): Omit<RoasResult, "value" | "reason"> {
  return {
    valueSource,
    currency: input.accountCurrency,
    attributionSpec: [...input.attributionSpec],
    dataAsOf: input.dataAsOf.toISOString(),
  };
}

export function computeMetaRoas(input: ComputeRoasInput): RoasResult {
  const common = base(input, "meta_value");
  if (input.valueSource !== "meta_value") {
    return { ...common, value: null, reason: "value_source_none", valueSource: input.valueSource };
  }
  if (input.spend <= 0) {
    return { ...common, value: null, reason: "no_spend" };
  }
  if (input.metaValue === null) {
    return { ...common, value: null, reason: "missing_meta_value" };
  }
  return { ...common, value: input.metaValue / input.spend };
}

export function computeExpectedValueRoas(input: ComputeRoasInput): RoasResult {
  const common = base(input, "fixed");
  if (input.valueSource !== "fixed") {
    return { ...common, value: null, reason: "value_source_none", valueSource: input.valueSource };
  }
  if (
    input.fixedCurrency !== null &&
    input.fixedCurrency !== input.accountCurrency
  ) {
    return {
      ...common,
      value: null,
      reason: "currency_mismatch",
      currency: input.fixedCurrency,
    };
  }
  if (input.spend <= 0) {
    return { ...common, value: null, reason: "no_spend" };
  }
  if (input.fixedValue === null || input.numeratorCount === null) {
    return { ...common, value: null, reason: "missing_meta_value" };
  }
  return {
    ...common,
    value: (input.fixedValue * input.numeratorCount) / input.spend,
  };
}

export function realizedValueRoasPlaceholder(input: ComputeRoasInput): RoasResult {
  return {
    ...base(input, "none"),
    value: null,
    reason: "value_source_none",
  };
}

export function attributionIsSynced(
  attributionSpec: readonly string[],
): boolean {
  if (attributionSpec.length !== SYNCED_ATTRIBUTION_SPEC.length) return false;
  const sorted = [...attributionSpec].sort();
  return SYNCED_ATTRIBUTION_SPEC.every((value, index) => sorted[index] === value);
}

export type SpendGateReason = Extract<GateReason, "no_spend" | "currency_mismatch">;
