import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { listTools } from "./tools/types";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolUseRequest {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelTurnResult {
  text: string;
  toolUses: ToolUseRequest[];
  stopReason: string;
}

export interface AgentModel {
  complete(params: {
    system: string;
    messages: AgentMessage[];
    signal: AbortSignal;
    onDelta?: (text: string) => Promise<void> | void;
  }): Promise<ModelTurnResult>;
}

/** Scripted model for tests — deterministic tool uses / text. */
export class ScriptedModel implements AgentModel {
  private index = 0;
  constructor(
    private readonly script: Array<{
      text?: string;
      toolUses?: ToolUseRequest[];
      stopReason?: string;
    }>,
  ) {}

  async complete(params: {
    system: string;
    messages: AgentMessage[];
    signal: AbortSignal;
    onDelta?: (text: string) => Promise<void> | void;
  }): Promise<ModelTurnResult> {
    void params.system;
    void params.messages;
    if (params.signal.aborted) throw new Error("aborted");
    const step = this.script[this.index] ?? { text: "", toolUses: [] };
    this.index += 1;
    const text = step.text ?? "";
    if (text && params.onDelta) await params.onDelta(text);
    return {
      text,
      toolUses: step.toolUses ?? [],
      stopReason: step.stopReason ?? (step.toolUses?.length ? "tool_use" : "end_turn"),
    };
  }
}

let testModelOverride: AgentModel | null = null;

export function setAgentModelForTests(model: AgentModel | null): void {
  testModelOverride = model;
}

export function getAgentModel(): AgentModel {
  if (testModelOverride) return testModelOverride;
  return new AnthropicModel();
}

class AnthropicModel implements AgentModel {
  async complete(params: {
    system: string;
    messages: AgentMessage[];
    signal: AbortSignal;
    onDelta?: (text: string) => Promise<void> | void;
  }): Promise<ModelTurnResult> {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Fail closed without a key — tests must inject ScriptedModel.
      return {
        text: "",
        toolUses: [],
        stopReason: "end_turn",
      };
    }
    const client = new Anthropic({ apiKey });
    const tools = listTools().map((tool) => ({
      name: tool.name,
      description: `${tool.description} [version=${tool.version}]`,
      input_schema: {
        type: "object" as const,
        additionalProperties: true,
      },
    }));

    const stream = client.messages.stream(
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: params.system,
        messages: params.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        tools,
      },
      { signal: params.signal },
    );

    let text = "";
    const toolUses: ToolUseRequest[] = [];

    // Serialize delta persistence so order matches token order and rejections
    // are not lost as unhandled promise rejections (Review-8 P0-2).
    let deltaChain: Promise<void> = Promise.resolve();
    stream.on("text", (delta) => {
      text += delta;
      if (params.onDelta) {
        deltaChain = deltaChain.then(() => Promise.resolve(params.onDelta!(delta)));
      }
    });

    const final = await stream.finalMessage();
    await deltaChain;
    for (const block of final.content) {
      if (block.type === "tool_use") {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
    return {
      text,
      toolUses,
      stopReason: final.stop_reason ?? "end_turn",
    };
  }
}
