import type { Queryable } from "@/db/queryable";
import type { RunEventKind } from "@/agent/types";

export interface RunEventRow {
  run_id: string;
  seq: string; // pg bigint
  kind: RunEventKind;
  payload: unknown;
  created_at: string;
}

/**
 * Append a run_event with a strictly monotonic, gapless seq per run.
 * Uses the transaction to serialize appends for one run.
 */
export async function appendRunEvent(
  db: Queryable,
  params: {
    runId: string;
    kind: RunEventKind;
    payload: unknown;
  },
): Promise<RunEventRow> {
  const result = await db.query<RunEventRow>(
    `WITH next AS (
       SELECT COALESCE(MAX(seq), 0) + 1 AS seq
       FROM run_event
       WHERE run_id = $1
     )
     INSERT INTO run_event (run_id, seq, kind, payload)
     SELECT $1, next.seq, $2, $3::jsonb FROM next
     RETURNING run_id, seq::text AS seq, kind, payload, created_at::text AS created_at`,
    [params.runId, params.kind, JSON.stringify(params.payload)],
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to append run_event");
  return row;
}

export async function listRunEventsAfter(
  db: Queryable,
  params: { runId: string; afterSeq: number },
): Promise<RunEventRow[]> {
  const result = await db.query<RunEventRow>(
    `SELECT run_id, seq::text AS seq, kind, payload, created_at::text AS created_at
     FROM run_event
     WHERE run_id = $1 AND seq > $2
     ORDER BY run_event.seq ASC`,
    [params.runId, params.afterSeq],
  );
  return result.rows;
}

export async function setTurnPhase(
  db: Queryable,
  params: { runId: string; phase: string; chatId?: string },
): Promise<RunEventRow> {
  await db.query(
    `UPDATE run SET turn_phase = $1, updated_at = now() WHERE id = $2`,
    [params.phase, params.runId],
  );
  return appendRunEvent(db, {
    runId: params.runId,
    kind: "turn_phase",
    payload: {
      kind: "turn_phase",
      phase: params.phase,
      runId: params.runId,
      ...(params.chatId ? { chatId: params.chatId } : {}),
    },
  });
}
