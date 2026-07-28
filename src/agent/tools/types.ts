import { z } from "zod";

/**
 * Capability boundary (SPEC §3.3) — hard, not cosmetic:
 *
 * Tools must not execute a shell, drive a browser, or fetch arbitrary URLs.
 * Only this application's own API and the Meta Graph API are allowed.
 *
 * When research tools or a landing-page builder land on the roadmap, this
 * boundary no longer holds and a sandbox worker is required.
 */
export type ToolKind = "sync" | "async_submit" | "job_control";
export type ToolCostClass = "cheap" | "moderate" | "expensive";
export type ToolSideEffect = "readOnly" | "writesInternal" | "external";

export interface ToolContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly agentLocale: "de" | "en";
}

export interface ToolDefinition<TInput, TResult> {
  name: string;
  /** Bumps when schema or resolution rules change — not on every code edit. */
  version: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  kind: ToolKind;
  costClass: ToolCostClass;
  sideEffect: ToolSideEffect;
  jobFamily?: string;
  /**
   * Resolve raw model arguments into the payload that will be hashed,
   * shown for approval, persisted, and executed. Defaults apply here.
   */
  resolve: (raw: TInput, ctx: ToolContext) => Promise<unknown> | unknown;
  handler: (resolved: unknown, ctx: ToolContext) => Promise<TResult>;
}

export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

const registry = new Map<string, AnyToolDefinition>();

export function registerTool(tool: AnyToolDefinition): void {
  if (registry.has(tool.name)) {
    throw new Error(`tool already registered: ${tool.name}`);
  }
  registry.set(tool.name, tool);
}

export function getTool(name: string): AnyToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(): AnyToolDefinition[] {
  return [...registry.values()];
}

export function clearToolRegistry(): void {
  registry.clear();
}

export function isToolRegistered(name: string): boolean {
  return registry.has(name);
}

/** Anthropic tool schema projection (JSON Schema subset via Zod). */
export function toAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return listTools().map((tool) => {
    // zod-to-json-schema is not a dependency; expose a minimal object schema
    // description and let the model use the tool description + our validation.
    return {
      name: tool.name,
      description: `${tool.description} [version=${tool.version}]`,
      input_schema: {
        type: "object",
        additionalProperties: true,
      },
    };
  });
}
