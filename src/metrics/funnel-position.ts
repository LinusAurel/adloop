import { createHash } from "node:crypto";
import { dataGateV1 } from "./score-config/data-gate-v1";
import { mean, stddevPop, winsorize, zScore } from "./stats";
import type { PerAdBaseMetrics } from "./resolve";
import type { MetricDefinitionInfo } from "./definition";
import {
  FUNNEL_POSITION_FORMULA_VERSION,
  type FunnelBand,
  type GateReason,
  type GateStatus,
} from "./types";

export interface FunnelAdScore {
  metaAdId: string;
  gateStatus: GateStatus;
  gateReasons: GateReason[];
  score: number | null;
  band: FunnelBand | null;
  components: {
    netNewReachShare: number | null;
    cvr: number | null;
    valuePerImpression: number | null;
  };
  z: {
    netNewReachShare: number | null;
    cvr: number | null;
    valuePerImpression: number | null;
  };
}

export interface FunnelPositionResult {
  formulaVersion: typeof FUNNEL_POSITION_FORMULA_VERSION;
  scoreConfigVersion: string;
  populationHash: string | null;
  populationSize: number;
  winsorBounds: Record<string, { lower: number; upper: number }>;
  componentMeans: Record<string, number>;
  componentStddevs: Record<string, number>;
  gateStatus: GateStatus;
  gateReasons: GateReason[];
  ads: FunnelAdScore[];
  accountCurrency: string;
  minSpend: number;
}

type ComponentKey = "netNewReachShare" | "cvr" | "valuePerImpression";

function bandFor(score: number): FunnelBand {
  if (score < -0.5) return "prospector";
  if (score > 0.5) return "closer";
  return "mixed";
}

function adGateReasons(
  row: PerAdBaseMetrics,
  metric: MetricDefinitionInfo,
  accountCurrency: string,
): GateReason[] {
  const reasons: GateReason[] = [];
  if (!row.windowSynced || row.reach === null) {
    reasons.push("window_not_synced");
  }
  if (row.netNewReachReason === "cumulative_reach_missing") {
    reasons.push("cumulative_reach_missing");
  }
  if (row.spend < dataGateV1.minSpend) {
    reasons.push("below_minimum_spend");
  }
  if (row.impressions < dataGateV1.minImpressions) {
    reasons.push("below_minimum_impressions");
  }
  if (row.reach !== null && row.reach <= 0) {
    reasons.push("zero_reach");
  }
  if (
    metric.denominator !== null &&
    (row.denominator === null || row.denominator <= 0)
  ) {
    reasons.push("zero_denominator");
  }
  void accountCurrency;
  return reasons;
}

function rawComponents(
  row: PerAdBaseMetrics,
  metric: MetricDefinitionInfo,
): Record<ComponentKey, number | null> {
  const netNewReachShare =
    row.netNewReach === null || row.reach === null || row.reach <= 0
      ? null
      : row.netNewReach / row.reach;

  const cvr =
    metric.denominator === null
      ? null
      : row.cvr;

  return {
    netNewReachShare,
    cvr,
    valuePerImpression: row.valuePerImpression,
  };
}

export function computeFunnelPosition(params: {
  rows: PerAdBaseMetrics[];
  metricDefinition: MetricDefinitionInfo;
  accountCurrency: string;
}): FunnelPositionResult {
  const { rows, metricDefinition, accountCurrency } = params;
  const hasCvr = metricDefinition.denominator !== null;

  const perAdGates = new Map<string, GateReason[]>();
  const population: PerAdBaseMetrics[] = [];
  for (const row of rows) {
    const reasons = adGateReasons(row, metricDefinition, accountCurrency);
    perAdGates.set(row.metaAdId, reasons);
    if (reasons.length === 0) population.push(row);
  }

  if (population.length < dataGateV1.minPopulation) {
    return {
      formulaVersion: FUNNEL_POSITION_FORMULA_VERSION,
      scoreConfigVersion: dataGateV1.version,
      populationHash: null,
      populationSize: population.length,
      winsorBounds: {},
      componentMeans: {},
      componentStddevs: {},
      gateStatus: "insufficient_data",
      gateReasons: ["population_too_small"],
      accountCurrency,
      minSpend: dataGateV1.minSpend,
      ads: rows.map((row) => ({
        metaAdId: row.metaAdId,
        gateStatus: "insufficient_data",
        gateReasons:
          (perAdGates.get(row.metaAdId)?.length ?? 0) > 0
            ? perAdGates.get(row.metaAdId)!
            : (["population_too_small"] as GateReason[]),
        score: null,
        band: null,
        components: rawComponents(row, metricDefinition),
        z: {
          netNewReachShare: null,
          cvr: null,
          valuePerImpression: null,
        },
      })),
    };
  }

  const populationHash = createHash("sha256")
    .update(population.map((row) => row.metaAdId).sort().join(","))
    .digest("hex");

  const componentValues: Record<ComponentKey, Array<{ id: string; value: number }>> = {
    netNewReachShare: [],
    cvr: [],
    valuePerImpression: [],
  };

  const componentsByAd = new Map<string, Record<ComponentKey, number | null>>();
  for (const row of population) {
    const components = rawComponents(row, metricDefinition);
    componentsByAd.set(row.metaAdId, components);
    for (const key of Object.keys(components) as ComponentKey[]) {
      if (key === "cvr" && !hasCvr) continue;
      const value = components[key];
      if (value !== null && Number.isFinite(value)) {
        componentValues[key].push({ id: row.metaAdId, value });
      }
    }
  }

  const winsorBounds: Record<string, { lower: number; upper: number }> = {};
  const winsorized: Record<ComponentKey, Map<string, number>> = {
    netNewReachShare: new Map(),
    cvr: new Map(),
    valuePerImpression: new Map(),
  };

  for (const key of Object.keys(componentValues) as ComponentKey[]) {
    const entries = componentValues[key];
    if (entries.length === 0) continue;
    const { winsorized: values, lower, upper } = winsorize(
      entries.map((entry) => entry.value),
    );
    winsorBounds[key] = { lower, upper };
    entries.forEach((entry, index) => {
      winsorized[key].set(entry.id, values[index]!);
    });
  }

  const componentMeans: Record<string, number> = {};
  const componentStddevs: Record<string, number> = {};
  const activeKeys: ComponentKey[] = [];

  for (const key of Object.keys(winsorized) as ComponentKey[]) {
    const values = [...winsorized[key].values()];
    if (values.length === 0) continue;
    const sd = stddevPop(values);
    if (sd === 0) continue;
    componentMeans[key] = mean(values);
    componentStddevs[key] = sd;
    activeKeys.push(key);
  }

  if (activeKeys.length === 0) {
    return {
      formulaVersion: FUNNEL_POSITION_FORMULA_VERSION,
      scoreConfigVersion: dataGateV1.version,
      populationHash,
      populationSize: population.length,
      winsorBounds,
      componentMeans,
      componentStddevs,
      gateStatus: "insufficient_data",
      gateReasons: ["no_variance"],
      accountCurrency,
      minSpend: dataGateV1.minSpend,
      ads: rows.map((row) => ({
        metaAdId: row.metaAdId,
        gateStatus: "insufficient_data",
        gateReasons:
          (perAdGates.get(row.metaAdId)?.length ?? 0) > 0
            ? perAdGates.get(row.metaAdId)!
            : (["no_variance"] as GateReason[]),
        score: null,
        band: null,
        components: componentsByAd.get(row.metaAdId) ?? rawComponents(row, metricDefinition),
        z: {
          netNewReachShare: null,
          cvr: null,
          valuePerImpression: null,
        },
      })),
    };
  }

  // Special rule: only CVR remains and every population CVR is null → no score.
  if (
    activeKeys.length === 1 &&
    activeKeys[0] === "cvr" &&
    population.every((row) => {
      const c = componentsByAd.get(row.metaAdId);
      return c?.cvr === null;
    })
  ) {
    return {
      formulaVersion: FUNNEL_POSITION_FORMULA_VERSION,
      scoreConfigVersion: dataGateV1.version,
      populationHash,
      populationSize: population.length,
      winsorBounds,
      componentMeans,
      componentStddevs,
      gateStatus: "insufficient_data",
      gateReasons: ["no_variance"],
      accountCurrency,
      minSpend: dataGateV1.minSpend,
      ads: rows.map((row) => ({
        metaAdId: row.metaAdId,
        gateStatus: "insufficient_data",
        gateReasons:
          (perAdGates.get(row.metaAdId)?.length ?? 0) > 0
            ? perAdGates.get(row.metaAdId)!
            : (["no_variance"] as GateReason[]),
        score: null,
        band: null,
        components: componentsByAd.get(row.metaAdId) ?? rawComponents(row, metricDefinition),
        z: {
          netNewReachShare: null,
          cvr: null,
          valuePerImpression: null,
        },
      })),
    };
  }

  const populationIds = new Set(population.map((row) => row.metaAdId));
  const ads: FunnelAdScore[] = rows.map((row) => {
    const gateReasons = perAdGates.get(row.metaAdId) ?? [];
    const components =
      componentsByAd.get(row.metaAdId) ?? rawComponents(row, metricDefinition);
    if (gateReasons.length > 0 || !populationIds.has(row.metaAdId)) {
      return {
        metaAdId: row.metaAdId,
        gateStatus: "insufficient_data",
        gateReasons: gateReasons.length > 0 ? gateReasons : ["population_too_small"],
        score: null,
        band: null,
        components,
        z: {
          netNewReachShare: null,
          cvr: null,
          valuePerImpression: null,
        },
      };
    }

    const z: FunnelAdScore["z"] = {
      netNewReachShare: null,
      cvr: null,
      valuePerImpression: null,
    };
    const parts: number[] = [];
    for (const key of activeKeys) {
      const raw = winsorized[key].get(row.metaAdId);
      if (raw === undefined) continue;
      const zValue = zScore(raw, componentMeans[key]!, componentStddevs[key]!);
      z[key] = zValue;
      // High net-new reach → Prospector → negative contribution.
      parts.push(key === "netNewReachShare" ? -zValue : zValue);
    }

    if (parts.length === 0) {
      return {
        metaAdId: row.metaAdId,
        gateStatus: "insufficient_data",
        gateReasons: ["no_variance"],
        score: null,
        band: null,
        components,
        z,
      };
    }

    const score = mean(parts);
    return {
      metaAdId: row.metaAdId,
      gateStatus: "ok",
      gateReasons: [],
      score,
      band: bandFor(score),
      components,
      z,
    };
  });

  return {
    formulaVersion: FUNNEL_POSITION_FORMULA_VERSION,
    scoreConfigVersion: dataGateV1.version,
    populationHash,
    populationSize: population.length,
    winsorBounds,
    componentMeans,
    componentStddevs,
    gateStatus: "ok",
    gateReasons: [],
    accountCurrency,
    minSpend: dataGateV1.minSpend,
    ads,
  };
}
