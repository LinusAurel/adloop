import { z } from "zod";
import { getPool } from "@/db/pool";
import {
  assembleContextPacket,
  computePromptHash,
  loadAdvertiserContentLocale,
} from "@/agent/context-packet";
import { getAgentModel } from "@/agent/model";
import { playbookBody, resolvePlaybook, PlaybookMissingError } from "@/agent/playbooks/resolve";
import { appendRunEvent, setTurnPhase } from "@/agent/run-events";
import {
  executePersistedApproval,
  executeToolCall,
} from "@/agent/tools/approvals";
import { ensureToolsBootstrapped } from "@/agent/tools/bootstrap";
import type { ToolContext } from "@/agent/tools/types";
import { HandlerError } from "@/queue/errors";
import type { JobFamilyDefinition } from "@/queue/types";

const AnalysisWindowSchema = z.object({
  since: z.string().date(),
  until: z.string().date(),
  dataAsOf: z.string().min(1),
});

export const AgentTurnInputSchema = z.object({
  runId: z.string().uuid(),
  chatId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  message: z.string().min(1),
  playbookSlug: z.string().min(1),
  agentLocale: z.enum(["de", "en"]),
  userId: z.string().uuid(),
  /** Etappe 5 — optional targeting. Absent → Etappe-4 default behaviour. */
  metaAdAccountId: z.string().uuid().optional(),
  metaAdId: z.string().min(1).optional(),
  analysisWindow: AnalysisWindowSchema.optional(),
  snapshotId: z.string().uuid().optional(),
});

const InputSchema = AgentTurnInputSchema;

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
    let terminalWritten = false;

    const writeTerminal = async (
      status: "completed" | "failed" | "cancelled",
      errorCode?: string,
    ) => {
      if (terminalWritten) return;
      terminalWritten = true;
      await appendRunEvent(pool, {
        runId,
        kind: "terminal",
        payload: {
          kind: "terminal",
          status,
          ...(errorCode ? { errorCode } : {}),
        },
      });
    };

    try {
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
          await writeTerminal("failed", "playbook_missing");
          throw new HandlerError("PLAYBOOK_MISSING", "playbook_missing", false);
        }
        throw error;
      }

      const contentLocale = await loadAdvertiserContentLocale(pool, ctx.tenantId);
      const windowEnd =
        ctx.input.analysisWindow?.until ??
        new Date().toISOString().slice(0, 10);
      const windowStart =
        ctx.input.analysisWindow?.since ??
        new Date(Date.parse(windowEnd) - 29 * 86_400_000)
          .toISOString()
          .slice(0, 10);

      let funnelSnapshot:
        | {
            id: string;
            score: number | null;
            gateStatus: string;
            gateReasons: string[];
            band: string | null;
            inputs: unknown;
            metricDefinitionId: string | null;
            metricDefinitionVersion: number | null;
            windowStart: string;
            windowEnd: string;
            dataAsOf: string;
          }
        | undefined;

      if (ctx.input.snapshotId) {
        const snap = await pool.query<{
          id: string;
          subject_id: string;
          meta_ad_account_id: string;
          window_start: string;
          window_end: string;
          data_as_of: string;
          value: string | null;
          gate_status: string;
          gate_reasons: string[];
          inputs: unknown;
          metric_definition_id: string | null;
          metric_definition_version: number | null;
        }>(
          `SELECT id, subject_id, meta_ad_account_id,
                  window_start::text, window_end::text, data_as_of::text,
                  value::text, gate_status, gate_reasons, inputs,
                  metric_definition_id::text, metric_definition_version
           FROM metric_snapshot
           WHERE id = $1 AND tenant_id = $2`,
          [ctx.input.snapshotId, ctx.tenantId],
        );
        const row = snap.rows[0];
        if (
          !row ||
          (ctx.input.metaAdId && row.subject_id !== ctx.input.metaAdId) ||
          (ctx.input.metaAdAccountId &&
            row.meta_ad_account_id !== ctx.input.metaAdAccountId) ||
          row.window_start !== windowStart ||
          row.window_end !== windowEnd
        ) {
          await setPhase("failed");
          await writeTerminal("failed", "snapshot_mismatch");
          throw new HandlerError("SNAPSHOT_MISMATCH", "snapshot_mismatch", false);
        }
        const inputs = row.inputs as { band?: string | null } | null;
        funnelSnapshot = {
          id: row.id,
          score: row.value !== null ? Number(row.value) : null,
          gateStatus: row.gate_status,
          gateReasons: row.gate_reasons,
          band: inputs?.band ?? null,
          inputs: row.inputs,
          metricDefinitionId: row.metric_definition_id,
          metricDefinitionVersion: row.metric_definition_version,
          windowStart: row.window_start,
          windowEnd: row.window_end,
          dataAsOf: row.data_as_of,
        };
      }

      const { packet: contextPacket, dataAsOf } = await assembleContextPacket(pool, {
        tenantId: ctx.tenantId,
        agentLocale: ctx.input.agentLocale,
        contentLocale,
        windowStart,
        windowEnd,
        metaAdAccountId: ctx.input.metaAdAccountId,
        metaAdId: ctx.input.metaAdId,
        dataAsOf: ctx.input.analysisWindow?.dataAsOf,
        funnelSnapshot,
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
            dataAsOf,
            metaAdAccountId: ctx.input.metaAdAccountId ?? null,
            metaAdId: ctx.input.metaAdId ?? null,
            snapshotId: ctx.input.snapshotId ?? null,
          }),
          runId,
        ],
      );

      // Strategist mapping rows keep the packet they were judged on.
      await pool.query(
        `UPDATE creative_strategy_run
         SET payload = payload || jsonb_build_object(
           'evidence', coalesce(payload->'evidence', '{}'::jsonb) || jsonb_build_object(
             'inputPacketMarkdown', $2::text
           )
         )
         WHERE run_id = $1 AND tenant_id = $3`,
        [runId, contextPacket, ctx.tenantId],
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

            // Production path: execute the persisted payload verbatim — never
            // re-resolve (Review-8 P0-1 / auftrag §0.1).
            const after = await executePersistedApproval(pool, {
              approvalId: executed.approval.id,
              tenantId: ctx.tenantId,
              ctx: toolCtx,
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
      await writeTerminal("completed");

      return {
        assistantMessageId: ctx.input.assistantMessageId,
        text: assistantText,
        playbookVersion: playbook.version,
        promptHash,
      };
    } catch (error) {
      const code =
        error instanceof HandlerError
          ? error.code
          : error instanceof Error
            ? "UNCAUGHT_EXCEPTION"
            : "UNKNOWN_ERROR";
      const status = code === "CANCELLED" ? "cancelled" : "failed";
      try {
        await setTurnPhase(pool, {
          runId,
          phase: status,
          chatId,
        });
      } catch {
        // Phase write is best-effort on the abort path.
      }
      await writeTerminal(status, code === "CANCELLED" ? undefined : code.toLowerCase());
      throw error;
    }
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
