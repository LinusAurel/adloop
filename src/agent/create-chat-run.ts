import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { withTransaction, type Queryable } from "@/db/queryable";
import { appendRunEvent, setTurnPhase } from "@/agent/run-events";

/**
 * Deterministic key-order comparison — jsonb round-trips can reorder keys.
 * Same helper as create-run.ts; duplicated to avoid a circular import.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

export const CreateChatRunInputSchema = z.object({
  runId: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  chatId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  message: z.string().min(1),
  playbookSlug: z.string().min(1).default("general"),
  agentLocale: z.enum(["de", "en"]).default("de"),
});
export type CreateChatRunInput = z.infer<typeof CreateChatRunInputSchema>;

export type CreateChatRunResult =
  | { outcome: "created"; runId: string }
  | { outcome: "idempotent_replay"; runId: string }
  | { outcome: "conflict"; runId: string }
  | { outcome: "chat_not_found" };

/**
 * Chat inherits createRun idempotency (auftrag §0.4): same runId + same
 * body → replay; divergent message / message ids / chat → 409.
 * Messages and job are created in ONE transaction.
 */
export async function createChatRun(
  db: Queryable,
  params: CreateChatRunInput,
): Promise<CreateChatRunResult> {
  const jobInput = {
    runId: params.runId,
    chatId: params.chatId,
    userMessageId: params.userMessageId,
    assistantMessageId: params.assistantMessageId,
    message: params.message,
    playbookSlug: params.playbookSlug,
    agentLocale: params.agentLocale,
    userId: params.userId,
  };

  const requestFingerprint = {
    chatId: params.chatId,
    userMessageId: params.userMessageId,
    assistantMessageId: params.assistantMessageId,
    message: params.message,
    playbookSlug: params.playbookSlug,
    agentLocale: params.agentLocale,
  };

  const result = await withTransaction(db, async (client) => {
    const chat = await client.query(
      `SELECT id FROM chat WHERE id = $1 AND tenant_id = $2`,
      [params.chatId, params.tenantId],
    );
    if (!chat.rows[0]) return { outcome: "chat_not_found" } as const;

    const inserted = await client.query(
      `INSERT INTO run (
         id, tenant_id, kind, status, chat_id, input, turn_phase,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'agent_turn', 'queued', $3, $4::jsonb, 'queued',
         now(), now()
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        params.runId,
        params.tenantId,
        params.chatId,
        JSON.stringify(requestFingerprint),
      ],
    );

    if (inserted.rows[0]) {
      await client.query(
        `INSERT INTO job (
           id, tenant_id, run_id, family, status, input, created_at, updated_at
         ) VALUES ($1, $2, $3, 'agent_turn', 'queued', $4::jsonb, now(), now())`,
        [uuidv7(), params.tenantId, params.runId, JSON.stringify(jobInput)],
      );

      await client.query(
        `INSERT INTO message (id, tenant_id, chat_id, role, content, run_id)
         VALUES ($1, $2, $3, 'user', $4, $5)`,
        [
          params.userMessageId,
          params.tenantId,
          params.chatId,
          params.message,
          params.runId,
        ],
      );
      await client.query(
        `INSERT INTO message (id, tenant_id, chat_id, role, content, run_id)
         VALUES ($1, $2, $3, 'assistant', '', $4)`,
        [
          params.assistantMessageId,
          params.tenantId,
          params.chatId,
          params.runId,
        ],
      );

      await setTurnPhase(client, {
        runId: params.runId,
        phase: "queued",
        chatId: params.chatId,
      });
      await appendRunEvent(client, {
        runId: params.runId,
        kind: "activity",
        payload: {
          kind: "activity",
          code: "run_queued",
          params: {},
        },
      });

      return { outcome: "created", runId: params.runId } as const;
    }

    const existing = await client.query<{
      tenant_id: string;
      kind: string;
      chat_id: string | null;
      input: unknown;
    }>(`SELECT tenant_id, kind, chat_id, input FROM run WHERE id = $1`, [
      params.runId,
    ]);
    const row = existing.rows[0];
    if (!row) return { outcome: "conflict", runId: params.runId } as const;

    const sameRequest =
      row.tenant_id === params.tenantId &&
      row.kind === "agent_turn" &&
      row.chat_id === params.chatId &&
      canonical(row.input) === canonical(requestFingerprint);

    return sameRequest
      ? ({ outcome: "idempotent_replay", runId: params.runId } as const)
      : ({ outcome: "conflict", runId: params.runId } as const);
  });

  if (result.outcome === "created") {
    await db.query(`SELECT pg_notify('job_available', $1)`, [params.runId]);
  }
  return result;
}
