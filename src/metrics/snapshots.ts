import { uuidv7 } from "uuidv7";
import type { Pool } from "pg";
import { computeCreativeStrain } from "./creative-strain";
import { computeFunnelPosition } from "./funnel-position";
import { dataAsOfParam, type DataAsOf } from "./data-as-of";
// dataAsOfParam (not cutoff) for persisted data_as_of equality with sync finished_at.
import { resolveMetrics } from "./resolve";
import {
  CREATIVE_STRAIN_FORMULA_VERSION,
  FUNNEL_POSITION_FORMULA_VERSION,
  type GateReason,
  type GateStatus,
} from "./types";

export interface ComputeSnapshotsParams {
  pool: Pool;
  tenantId: string;
  adAccountId: string;
  windowStart: string;
  windowEnd: string;
  dataAsOf: DataAsOf;
  sourceSyncRunIds: string[];
}

export interface SnapshotWriteResult {
  funnelSnapshotIds: string[];
  strainSnapshotIds: string[];
}

export interface SnapshotScoreRow {
  subjectId: string;
  formulaVersion: string;
  value: number | null;
  gateStatus: GateStatus;
  gateReasons: GateReason[];
  inputs: unknown;
  scoreConfigVersion: string;
  metricDefinitionId: string | null;
  metricDefinitionVersion: number | null;
  populationHash: string | null;
  populationSize: number | null;
  winsorBounds: unknown;
  componentMeans: unknown;
  componentStddevs: unknown;
  band?: string | null;
}

async function insertSnapshot(
  pool: Pool,
  row: {
    tenantId: string;
    subjectType: "account" | "ad";
    subjectId: string;
    metaAdAccountId: string;
    windowStart: string;
    windowEnd: string;
    dataAsOf: DataAsOf;
    sourceSyncRunIds: string[];
    formulaVersion: string;
    scoreConfigVersion: string;
    metricDefinitionId: string | null;
    metricDefinitionVersion: number | null;
    populationHash: string | null;
    populationSize: number | null;
    winsorBounds: unknown;
    componentMeans: unknown;
    componentStddevs: unknown;
    inputs: unknown;
    value: number | null;
    gateStatus: GateStatus;
    gateReasons: GateReason[];
  },
): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO metric_snapshot (
       id, tenant_id, subject_type, subject_id, meta_ad_account_id,
       window_start, window_end, data_as_of, source_sync_run_ids,
       formula_version, score_config_version,
       metric_definition_id, metric_definition_version,
       population_hash, population_size,
       winsor_bounds, component_means, component_stddevs,
       inputs, value, gate_status, gate_reasons
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::date, $7::date, $8::timestamptz, $9::uuid[],
       $10, $11,
       $12, $13,
       $14, $15,
       $16::jsonb, $17::jsonb, $18::jsonb,
       $19::jsonb, $20, $21, $22::text[]
     )`,
    [
      id,
      row.tenantId,
      row.subjectType,
      row.subjectId,
      row.metaAdAccountId,
      row.windowStart,
      row.windowEnd,
      dataAsOfParam(row.dataAsOf),
      row.sourceSyncRunIds,
      row.formulaVersion,
      row.scoreConfigVersion,
      row.metricDefinitionId,
      row.metricDefinitionVersion,
      row.populationHash,
      row.populationSize,
      JSON.stringify(row.winsorBounds),
      JSON.stringify(row.componentMeans),
      JSON.stringify(row.componentStddevs),
      JSON.stringify(row.inputs),
      row.value,
      row.gateStatus,
      row.gateReasons,
    ],
  );
  return id;
}

/** Always inserts new rows — never updates existing snapshots. */
export async function computeAndPersistSnapshots(
  params: ComputeSnapshotsParams,
): Promise<SnapshotWriteResult> {
  const resolved = await resolveMetrics({
    pool: params.pool,
    tenantId: params.tenantId,
    adAccountId: params.adAccountId,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    dataAsOf: params.dataAsOf,
  });

  const funnel = computeFunnelPosition({
    rows: resolved.rows,
    metricDefinition: resolved.metricDefinition,
    accountCurrency: resolved.accountCurrency,
  });

  const strain = await computeCreativeStrain({
    pool: params.pool,
    tenantId: params.tenantId,
    adAccountId: params.adAccountId,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    dataAsOf: params.dataAsOf,
    metaAdIds: resolved.rows.map((row) => row.metaAdId),
  });

  const sourceSyncRunIds = [
    ...new Set([
      ...params.sourceSyncRunIds,
      ...resolved.rows.flatMap((row) => row.syncRunIds),
    ]),
  ];

  const funnelSnapshotIds: string[] = [];
  const strainSnapshotIds: string[] = [];

  for (const ad of funnel.ads) {
    funnelSnapshotIds.push(
      await insertSnapshot(params.pool, {
        tenantId: params.tenantId,
        subjectType: "ad",
        subjectId: ad.metaAdId,
        metaAdAccountId: params.adAccountId,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        dataAsOf: params.dataAsOf,
        sourceSyncRunIds,
        formulaVersion: FUNNEL_POSITION_FORMULA_VERSION,
        scoreConfigVersion: funnel.scoreConfigVersion,
        metricDefinitionId: resolved.metricDefinition.id,
        metricDefinitionVersion: resolved.metricDefinition.version,
        populationHash: funnel.populationHash,
        populationSize: funnel.populationSize,
        winsorBounds: funnel.winsorBounds,
        componentMeans: funnel.componentMeans,
        componentStddevs: funnel.componentStddevs,
        inputs: {
          components: ad.components,
          z: ad.z,
          accountCurrency: resolved.accountCurrency,
          minSpend: funnel.minSpend,
          scoreConfigVersion: funnel.scoreConfigVersion,
          band: ad.band,
        },
        value: ad.score,
        gateStatus: ad.gateStatus,
        gateReasons: ad.gateReasons,
      }),
    );
  }

  for (const ad of strain.ads) {
    strainSnapshotIds.push(
      await insertSnapshot(params.pool, {
        tenantId: params.tenantId,
        subjectType: "ad",
        subjectId: ad.metaAdId,
        metaAdAccountId: params.adAccountId,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        dataAsOf: params.dataAsOf,
        sourceSyncRunIds,
        formulaVersion: CREATIVE_STRAIN_FORMULA_VERSION,
        scoreConfigVersion: strain.scoreConfigVersion,
        metricDefinitionId: resolved.metricDefinition.id,
        metricDefinitionVersion: resolved.metricDefinition.version,
        populationHash: null,
        populationSize: null,
        winsorBounds: {},
        componentMeans: {},
        componentStddevs: {},
        inputs: {
          components: ad.components,
          accountCurrency: resolved.accountCurrency,
        },
        value: ad.value,
        gateStatus: ad.gateStatus,
        gateReasons: ad.gateReasons,
      }),
    );
  }

  return { funnelSnapshotIds, strainSnapshotIds };
}

/**
 * Read the newest snapshot row for each subject at a given data_as_of.
 * Historical scores are facts — never recompute with today's formula.
 *
 * `formulaVersion` is an exact pin (optional). Historical callers should omit
 * it and pass `formulaPrefix` so a stored v1 remains readable after the
 * compiled constant moves to v2. Newest `computed_at` wins on ties.
 */
export async function readScoreSnapshots(params: {
  pool: Pool;
  tenantId: string;
  adAccountId: string;
  windowStart: string;
  windowEnd: string;
  dataAsOf: DataAsOf;
  formulaVersion?: string;
  formulaPrefix?: string;
  subjectIds?: string[];
}): Promise<Map<string, SnapshotScoreRow>> {
  const asOf = dataAsOfParam(params.dataAsOf);
  const result = await params.pool.query<{
    subject_id: string;
    formula_version: string;
    value: string | null;
    gate_status: GateStatus;
    gate_reasons: GateReason[];
    inputs: unknown;
    score_config_version: string;
    metric_definition_id: string | null;
    metric_definition_version: number | null;
    population_hash: string | null;
    population_size: number | null;
    winsor_bounds: unknown;
    component_means: unknown;
    component_stddevs: unknown;
  }>(
    `SELECT DISTINCT ON (subject_id)
       subject_id,
       formula_version,
       value::text,
       gate_status,
       gate_reasons,
       inputs,
       score_config_version,
       metric_definition_id::text,
       metric_definition_version,
       population_hash,
       population_size,
       winsor_bounds,
       component_means,
       component_stddevs
     FROM metric_snapshot
     WHERE tenant_id = $1
       AND meta_ad_account_id = $2
       AND subject_type = 'ad'
       AND window_start = $3::date
       AND window_end = $4::date
       AND data_as_of = $5::timestamptz
       AND ($6::text IS NULL OR formula_version = $6)
       AND ($7::text IS NULL OR formula_version LIKE ($7 || '%'))
       AND ($8::text[] IS NULL OR subject_id = ANY($8::text[]))
     ORDER BY subject_id, computed_at DESC`,
    [
      params.tenantId,
      params.adAccountId,
      params.windowStart,
      params.windowEnd,
      asOf,
      params.formulaVersion ?? null,
      params.formulaPrefix ?? null,
      params.subjectIds ?? null,
    ],
  );

  return new Map(
    result.rows.map((row) => [
      row.subject_id,
      {
        subjectId: row.subject_id,
        formulaVersion: row.formula_version,
        value: row.value === null ? null : Number(row.value),
        gateStatus: row.gate_status,
        gateReasons: row.gate_reasons,
        inputs: row.inputs,
        scoreConfigVersion: row.score_config_version,
        metricDefinitionId: row.metric_definition_id,
        metricDefinitionVersion: row.metric_definition_version,
        populationHash: row.population_hash,
        populationSize: row.population_size,
        winsorBounds: row.winsor_bounds,
        componentMeans: row.component_means,
        componentStddevs: row.component_stddevs,
        band:
          row.inputs &&
          typeof row.inputs === "object" &&
          row.inputs !== null &&
          "band" in row.inputs
            ? ((row.inputs as { band?: string | null }).band ?? null)
            : null,
      },
    ]),
  );
}

/** Latest succeeded sync finished_at as timestamptz text (microsecond-safe). */
export async function latestSyncDataAsOf(
  pool: Pool,
  tenantId: string,
  adAccountId: string,
): Promise<string | null> {
  const result = await pool.query<{ finished_at: string }>(
    `SELECT finished_at::text AS finished_at
     FROM insight_sync_run
     WHERE tenant_id = $1
       AND meta_ad_account_id = $2
       AND status = 'succeeded'
       AND finished_at IS NOT NULL
     ORDER BY finished_at DESC
     LIMIT 1`,
    [tenantId, adAccountId],
  );
  return result.rows[0]?.finished_at ?? null;
}

export function isLatestDataAsOf(
  dataAsOf: string,
  latestFinishedAt: string | null,
): boolean {
  if (latestFinishedAt === null) return true;
  return dataAsOf === latestFinishedAt;
}

/** Timestamptz-equal comparison — formats from API vs Postgres ::text may differ. */
export async function dataAsOfIsLatestSync(
  pool: Pool,
  dataAsOf: string,
  latestFinishedAt: string | null,
): Promise<boolean> {
  if (latestFinishedAt === null) return true;
  const result = await pool.query<{ same: boolean }>(
    `SELECT $1::timestamptz = $2::timestamptz AS same`,
    [dataAsOf, latestFinishedAt],
  );
  return result.rows[0]?.same === true;
}
