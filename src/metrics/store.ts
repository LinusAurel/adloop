import { uuidv7 } from "uuidv7";
import type { Pool } from "pg";
import {
  CreateConversionMetricSchema,
  canonicalizeAttributionSpec,
  toMetricDefinitionInfo,
  type CreateConversionMetricInput,
  type MetricDefinitionInfo,
  type StoredMetricRow,
} from "./definition";
import { assertSumDisjointAllowed, MetricConfigError } from "./action-overlaps";

export async function createConversionMetric(
  pool: Pool,
  params: {
    tenantId: string;
    input: CreateConversionMetricInput;
  },
): Promise<MetricDefinitionInfo> {
  const parsed = CreateConversionMetricSchema.parse(params.input);
  if (parsed.numeratorAggregation === "sum_disjoint") {
    assertSumDisjointAllowed(parsed.numeratorActionTypes);
  }
  const id = uuidv7();
  const attributionSpec = canonicalizeAttributionSpec(parsed.attributionSpec);
  const effectiveFrom = parsed.effectiveFrom ?? new Date().toISOString();

  await pool.query(
    `INSERT INTO conversion_metric (
       id, tenant_id, label, version,
       numerator_action_types, numerator_aggregation, attribution_spec,
       denominator, value_source, fixed_value, currency,
       effective_from, effective_to
     ) VALUES (
       $1, $2, $3, 1, $4::text[], $5, $6::text[], $7, $8, $9, $10, $11, NULL
     )`,
    [
      id,
      params.tenantId,
      parsed.label,
      parsed.numeratorActionTypes,
      parsed.numeratorAggregation,
      attributionSpec,
      parsed.denominator,
      parsed.valueSource,
      parsed.valueSource === "fixed" ? parsed.fixedValue : null,
      parsed.valueSource === "fixed" ? parsed.currency : null,
      effectiveFrom,
    ],
  );

  return toMetricDefinitionInfo(
    {
      id,
      version: 1,
      label: parsed.label,
      numerator_action_types: parsed.numeratorActionTypes,
      numerator_aggregation: parsed.numeratorAggregation,
      attribution_spec: attributionSpec,
      denominator: parsed.denominator,
      value_source: parsed.valueSource,
      fixed_value:
        parsed.valueSource === "fixed" && parsed.fixedValue !== null
          ? String(parsed.fixedValue)
          : null,
      currency: parsed.valueSource === "fixed" ? (parsed.currency ?? null) : null,
    },
    "user",
  );
}

/**
 * Append a new version of an existing metric. Never mutates prior rows —
 * snapshots keep pointing at the old (id, version). Supersession is resolved
 * at read time via created_at <= dataAsOf (and effective_from <= windowEnd).
 */
export async function createConversionMetricVersion(
  pool: Pool,
  params: {
    tenantId: string;
    metricId: string;
    input: CreateConversionMetricInput;
  },
): Promise<MetricDefinitionInfo> {
  const parsed = CreateConversionMetricSchema.parse(params.input);
  if (parsed.numeratorAggregation === "sum_disjoint") {
    assertSumDisjointAllowed(parsed.numeratorActionTypes);
  }
  const attributionSpec = canonicalizeAttributionSpec(parsed.attributionSpec);
  const effectiveFrom = parsed.effectiveFrom ?? new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ version: number }>(
      `SELECT version
       FROM conversion_metric
       WHERE tenant_id = $1 AND id = $2
       ORDER BY version DESC
       LIMIT 1
       FOR UPDATE`,
      [params.tenantId, params.metricId],
    );
    if (!current.rows[0]) {
      throw new MetricConfigError("metric_not_found", "conversion metric not found");
    }
    const nextVersion = current.rows[0].version + 1;
    await client.query(
      `INSERT INTO conversion_metric (
         id, tenant_id, label, version,
         numerator_action_types, numerator_aggregation, attribution_spec,
         denominator, value_source, fixed_value, currency,
         effective_from, effective_to
       ) VALUES (
         $1, $2, $3, $4, $5::text[], $6, $7::text[], $8, $9, $10, $11, $12, NULL
       )`,
      [
        params.metricId,
        params.tenantId,
        parsed.label,
        nextVersion,
        parsed.numeratorActionTypes,
        parsed.numeratorAggregation,
        attributionSpec,
        parsed.denominator,
        parsed.valueSource,
        parsed.valueSource === "fixed" ? parsed.fixedValue : null,
        parsed.valueSource === "fixed" ? parsed.currency : null,
        effectiveFrom,
      ],
    );
    await client.query("COMMIT");
    return toMetricDefinitionInfo(
      {
        id: params.metricId,
        version: nextVersion,
        label: parsed.label,
        numerator_action_types: parsed.numeratorActionTypes,
        numerator_aggregation: parsed.numeratorAggregation,
        attribution_spec: attributionSpec,
        denominator: parsed.denominator,
        value_source: parsed.valueSource,
        fixed_value:
          parsed.valueSource === "fixed" && parsed.fixedValue !== null
            ? String(parsed.fixedValue)
            : null,
        currency:
          parsed.valueSource === "fixed" ? (parsed.currency ?? null) : null,
      },
      "user",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function assignMetricToAdAccount(
  pool: Pool,
  params: {
    tenantId: string;
    metaAdAccountId: string;
    conversionMetricId: string;
    effectiveFrom?: string;
  },
): Promise<{ assignmentId: string }> {
  const metric = await pool.query(
    `SELECT 1 FROM conversion_metric
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [params.tenantId, params.conversionMetricId],
  );
  if (!metric.rows[0]) {
    throw new MetricConfigError("metric_not_found", "conversion metric not found");
  }

  const effectiveFrom = params.effectiveFrom ?? new Date().toISOString();
  const assignmentId = uuidv7();
  // Append-only: never UPDATE prior assignments. Resolve picks the assignment
  // known at dataAsOf (created_at <= dataAsOf) with the latest effective_from.
  await pool.query(
    `INSERT INTO ad_account_metric_assignment (
       id, tenant_id, meta_ad_account_id, conversion_metric_id,
       effective_from, effective_to
     ) VALUES ($1, $2, $3, $4, $5, NULL)`,
    [
      assignmentId,
      params.tenantId,
      params.metaAdAccountId,
      params.conversionMetricId,
      effectiveFrom,
    ],
  );
  return { assignmentId };
}

export async function listConversionMetrics(
  pool: Pool,
  tenantId: string,
): Promise<MetricDefinitionInfo[]> {
  const result = await pool.query<StoredMetricRow>(
    `SELECT DISTINCT ON (id)
       id, version, label, numerator_action_types, numerator_aggregation,
       attribution_spec, denominator, value_source,
       fixed_value::text, currency
     FROM conversion_metric
     WHERE tenant_id = $1
     ORDER BY id, version DESC`,
    [tenantId],
  );
  return result.rows.map((row) => toMetricDefinitionInfo(row, "user"));
}
