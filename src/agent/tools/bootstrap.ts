import {
  clearToolRegistry,
  isToolRegistered,
  registerTool,
  type AnyToolDefinition,
} from "./types";
import {
  getAccountMetricsTool,
  getAdDetailTool,
  getJobResultTool,
  getJobStatusTool,
  listAdsTool,
  triggerMetaSyncTool,
} from "./builtins";

export function ensureToolsBootstrapped(): void {
  const tools: AnyToolDefinition[] = [
    getAccountMetricsTool as AnyToolDefinition,
    listAdsTool as AnyToolDefinition,
    getAdDetailTool as AnyToolDefinition,
    triggerMetaSyncTool as AnyToolDefinition,
    getJobStatusTool as AnyToolDefinition,
    getJobResultTool as AnyToolDefinition,
  ];
  for (const tool of tools) {
    if (!isToolRegistered(tool.name)) {
      registerTool(tool);
    }
  }
}

export function resetToolsForTests(): void {
  clearToolRegistry();
  ensureToolsBootstrapped();
}
