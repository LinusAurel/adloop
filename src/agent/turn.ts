import { z } from "zod";
import { getPool } from "@/db/pool";
import {
  computePromptHash,
  emptyContextPacket,
  loadAdvertiserContentLocale,
} from "@/agent/context-packet";
import { getAgentModel } from "@/agent/model";
import { playbookBody, resolvePlaybook, PlaybookMissingError } from "@/agent/playbooks/resolve";
import { appendRunEvent, setTurnPhase } from "@/agent/run-events";
import { executeToolCall } from "@/agent/tools/approvals";
import { ensureToolsBootstrapped } from "@/agent/tools/bootstrap";
import type { ToolContext } from "@/agent/tools/types";
import { HandlerError } from "@/queue/errors";
import type { JobFamilyDefinition } from "@/queue/types";

const InputSchema = z.object({
  runId: z.string().uuid(),
  chatId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  message: z.string().min(1),
  playbookSlug: z.string().min(1),
  agentLocale: z.enum(["de", "en"]),
  userId: z.string().uuid(),
});

const ResultSchema = z.object({
  assistantMessageId: z.string().uuid(),
  text: z.string(),
  playbookVersion: z.string(),
  promptHash: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Result = z.infer<typeof ResultSchema>;

export const AGENT_SYSTEM_INSTRUCTION = `You are adloop's account analyst. Use tools when you need facts.
Answer in the agent_locale given in the context packet.
Do not invent metrics. Prefer tools over guessing.
Tools may only use this application's API and the Meta Graph API.`;

/**
 * Agent turn job family. Turn phases live on run.turn_phase; queue status
 * stays on the Etappe-1 primitives (auftrag §0).
 */
export const agentTurnFamily: JobFamilyDefinition<Input, Result> = {
  name: "agent_turn",
  inputSchema: InputSchema,
  resultSchema: ResultSchema,
  maxAttempts: 3,
  timeoutMs: 10 * 60 * 1000,

  async handler(ctx) {
    ensureToolsBootstrapped();
    const pool = getPool();
    const chatId = ctx.input.chatId;
    const runId = ctx.input.runId;

    const setPhase = async (name: string) => {
      await setTurnPhase(pool, { runId, phase: name, chatId });
      await ctx.progress({
        state: name,
        code: "turn_phase",
        params: { phase: name },
        percent: phasePercent(name),
      });
    };

    await setPhase("claimed");
    await setPhase("assembling_context");

    let playbook;
    try {
      playbook = await resolvePlaybook(pool, {
        tenantId: ctx.tenantId,
        slug: ctx.input.playbookSlug,
      });
    } catch (error) {
      if (error instanceof PlaybookMissingError) {
        await setPhase("failed");
        await appendRunEvent(pool, {
          runId,
          kind: "terminal",
          payload: { kind: "terminal", status: "failed", errorCode: "playbook_missing" },
        });
        throw new HandlerError("PLAYBOOK_MISSING", "playbook_missing", false);
      }
      throw error;
    }

    const contentLocale = await loadAdvertiserContentLocale(pool, ctx.tenantId);
    const windowEnd = new Date().toISOString().slice(0, 10);
    const windowStart = new Date(Date.parse(windowEnd) - 29 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const contextPacket = emptyContextPacket({
      agentLocale: ctx.input.agentLocale,
      contentLocale,
      windowStart,
      windowEnd,
    });
    const playbookContent = playbookBody(playbook);
    const promptHash = computePromptHash({
      systemInstruction: AGENT_SYSTEM_INSTRUCTION,
      playbookContent,
      contextPacket,
      userMessage: ctx.input.message,
    });

    await pool.query(
      `UPDATE run
       SET context_packet = $1,
           playbook_version = $2,
           prompt_hash = $3,
           resolved_input = $4::jsonb,
           updated_at = now()
       WHERE id = $5`,
      [
        contextPacket,
        playbook.version,
        promptHash,
        JSON.stringify({
          playbookSlug: ctx.input.playbookSlug,
          agentLocale: ctx.input.agentLocale,
          contentLocale,
          windowStart,
          windowEnd,
        }),
        runId,
      ],
    );

    await setPhase("invoking_model");
    await appendRunEvent(pool, {
      runId,
      kind: "activity",
      payload: {
        kind: "activity",
        code: "model_invoking",
        params: { playbookVersion: playbook.version },
      },
    });

    const model = getAgentModel();
    const system = [
      AGENT_SYSTEM_INSTRUCTION,
      "",
      "# Playbook",
      playbookContent,
      "",
      "# Context packet",
      contextPacket,
    ].join("\n");

    await setPhase("streaming");
    let assistantText = "";
    const maxRounds = 8;
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: ctx.input.message },
    ];

    const toolCtx: ToolContext = {
      tenantId: ctx.tenantId,
      userId: ctx.input.userId,
      runId,
      signal: ctx.signal,
      agentLocale: ctx.input.agentLocale,
    };

    for (let round = 0; round < maxRounds; round++) {
      if (ctx.signal.aborted) {
        throw new HandlerError("CANCELLED", "cancelled", false);
      }
      const textBefore = assistantText;
      const turn = await model.complete({
        system,
        messages,
        signal: ctx.signal,
        onDelta: async (delta) => {
          assistantText += delta;
          await appendRunEvent(pool, {
            runId,
            kind: "delta",
            payload: {
              kind: "delta",
              text: delta,
              messageId: ctx.input.assistantMessageId,
            },
          });
        },
      });

      // If the model returned text without streaming deltas, emit once.
      if (turn.text && assistantText === textBefore) {
        assistantText += turn.text;
        await appendRunEvent(pool, {
          runId,
          kind: "delta",
          payload: {
            kind: "delta",
            text: turn.text,
            messageId: ctx.input.assistantMessageId,
          },
        });
      }

      if (!turn.toolUses.length) {
        break;
      }

      await setPhase("harvesting_outputs");
      const toolResults: string[] = [];
      for (const use of turn.toolUses) {
        await appendRunEvent(pool, {
          runId,
          kind: "activity",
          payload: {
            kind: "activity",
            code: "tool_running",
            params: { tool: use.name },
          },
        });

        const executed = await executeToolCall(pool, {
          ctx: toolCtx,
          toolName: use.name,
          rawInput: use.input,
          requestApproval: true,
        });

        if (executed.outcome === "needs_approval") {
          await setPhase("awaiting_approval");
          await appendRunEvent(pool, {
            runId,
            kind: "activity",
            payload: {
              kind: "activity",
              code: "approval_required",
              params: {
                approvalId: executed.approval.id,
                tool: use.name,
                resolvedRequestHash: executed.approval.resolved_request_hash,
                costEstimate: executed.approval.cost_estimate ?? "moderate",
              },
            },
          });

          const approval = await waitForApprovalDecision(pool, {
            approvalId: executed.approval.id,
            signal: ctx.signal,
            onTick: async () => {
              await ctx.progress({
                state: "awaiting_approval",
                code: "waiting_approval",
                params: { approvalId: executed.approval.id },
                percent: 60,
              });
            },
          });

          if (!approval?.decided_by) {
            throw new HandlerError("APPROVAL_TIMEOUT", "approval_timeout", false);
          }

          const after = await executeToolCall(pool, {
            ctx: toolCtx,
            toolName: use.name,
            rawInput: use.input,
          });
          if (after.outcome !== "executed") {
            throw new HandlerError(
              "APPROVAL_REJECTED",
              after.outcome === "rejected" ? after.code : "approval_failed",
              false,
            );
          }
          toolResults.push(JSON.stringify({ tool: use.name, result: after.result }));
          await appendRunEvent(pool, {
            runId,
            kind: "activity",
            payload: {
              kind: "activity",
              code: "tool_completed",
              params: { tool: use.name },
            },
          });
          await setPhase("streaming");
          continue;
        }

        if (executed.outcome === "rejected") {
          toolResults.push(JSON.stringify({ tool: use.name, error: executed.code }));
          continue;
        }

        toolResults.push(JSON.stringify({ tool: use.name, result: executed.result }));
        await appendRunEvent(pool, {
          runId,
          kind: "activity",
          payload: {
            kind: "activity",
            code: "tool_completed",
            params: { tool: use.name },
          },
        });
      }

      messages.push({
        role: "assistant",
        content:
          turn.text ||
          `(tool calls: ${turn.toolUses.map((t) => t.name).join(", ")})`,
      });
      messages.push({
        role: "user",
        content: `Tool results:\n${toolResults.join("\n")}`,
      });
    }

    await setPhase("finalizing");

    const renderArtifacts = [
      {
        kind: "text_block",
        runId,
        fields: [
          {
            fieldId: "body",
            label: "Response",
            value: assistantText,
          },
        ],
      },
    ];

    await pool.query(
      `UPDATE message
       SET content = $1,
           render_artifacts = $2::jsonb,
           tool_invocations = $3::jsonb
       WHERE id = $4 AND tenant_id = $5`,
      [
        assistantText,
        JSON.stringify(renderArtifacts),
        JSON.stringify([]),
        ctx.input.assistantMessageId,
        ctx.tenantId,
      ],
    );

    await setPhase("completed");
    await appendRunEvent(pool, {
      runId,
      kind: "terminal",
      payload: { kind: "terminal", status: "completed" },
    });

    return {
      assistantMessageId: ctx.input.assistantMessageId,
      text: assistantText,
      playbookVersion: playbook.version,
      promptHash,
    };
  },
};

function phasePercent(phase: string): number {
  const order = [
    "queued",
    "claimed",
    "assembling_context",
    "invoking_model",
    "streaming",
    "harvesting_outputs",
    "awaiting_approval",
    "finalizing",
    "completed",
  ];
  const idx = order.indexOf(phase);
  if (idx < 0) return 0;
  return Math.round((idx / (order.length - 1)) * 100);
}

async function waitForApprovalDecision(
  pool: ReturnType<typeof getPool>,
  params: {
    approvalId: string;
    signal: AbortSignal;
    onTick: () => Promise<void>;
    timeoutMs?: number;
  },
): Promise<{ decided_by: string | null } | null> {
  const deadline = Date.now() + (params.timeoutMs ?? 10 * 60 * 1000);
  while (Date.now() < deadline) {
    if (params.signal.aborted) return null;
    const row = await pool.query<{
      decided_by: string | null;
      decided_at: string | null;
      consumed_at: string | null;
    }>(
      `SELECT decided_by, decided_at, consumed_at FROM tool_approval WHERE id = $1`,
      [params.approvalId],
    );
    const approval = row.rows[0];
    if (approval?.decided_at) {
      return { decided_by: approval.decided_by };
    }
    await params.onTick();
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
