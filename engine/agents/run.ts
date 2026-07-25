// Small run helpers for the ticker (SPEC §6). Local to the agent layer so
// stream B does not have to touch the shared store module.

import { appendRunLog, newId, readCollection, upsert, writeCollection } from "../store.ts";
import type { Run } from "../types.ts";

export function startRun(brandSlug: string, stage: string): Run {
  const run: Run = {
    id: newId("run"),
    brandSlug,
    stage,
    log: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  upsert("runs", run);
  return run;
}

export function endRun(runId: string): void {
  const runs = readCollection("runs");
  const run = runs.find((r) => r.id === runId);
  if (!run) return;
  run.finishedAt = new Date().toISOString();
  writeCollection("runs", runs);
}

export function logLine(
  runId: string,
  agent: string,
  message: string,
  level: "info" | "warn" | "error" = "info",
): void {
  appendRunLog(runId, agent, message, level);
}
