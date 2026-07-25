// Small run helpers for the ticker (SPEC §6). Local to the agent layer so
// stream B does not have to touch the shared store module. Since the async
// job pattern (#7) these delegate to the store so run status semantics
// (running/finished/failed) live in exactly one place.

import { appendRunLog, createRun, finishRun } from "../store.ts";
import type { Run } from "../types.ts";

export function startRun(brandSlug: string, stage: string): Run {
  return createRun(brandSlug, stage);
}

export function endRun(runId: string, error?: string): void {
  finishRun(runId, error);
}

export function logLine(
  runId: string,
  agent: string,
  message: string,
  level: "info" | "warn" | "error" = "info",
): void {
  appendRunLog(runId, agent, message, level);
}
