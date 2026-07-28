import { uuidv7 } from "uuidv7";
import type { Pool } from "pg";
import { computeCreativeStrain } from "./creative-strain";
import { computeFunnelPosition } from "./funnel-position";
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
  dataAsOf: Date;
  sourceSyncRunIds: string[];
}

export interface SnapshotWriteResult {
  funnelSnapshotIds: string[];
  strainSnapshotIds: string[];
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
    dataAsOf: Date;
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
       $6::date, $7::date, $8, $9::uuid[],
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
      row.dataAsOf.toISOString(),
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
