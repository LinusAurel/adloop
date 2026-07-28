import { uuidv7 } from "uuidv7";
import type { PoolClient } from "pg";
import { withTransaction, type Queryable } from "@/db/queryable";
import { sha256Canonical } from "@/lib/canonical-json";
import { getTool, type ToolContext } from "./types";

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface ToolApprovalRow {
  id: string;
  tenant_id: string;
  run_id: string;
  tool_name: string;
  tool_version: string;
  resolved_payload: unknown;
  resolved_request_hash: string;
  operation_id: string;
  cost_estimate: string | null;
  scope: unknown;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string;
  consumed_at: string | null;
}

export type ExecuteToolResult =
  | { outcome: "executed"; result: unknown; operationId: string; approvalId?: string }
  | { outcome: "needs_approval"; approval: ToolApprovalRow }
  | {
      outcome: "rejected";
      code:
        | "approval_required"
        | "approval_hash_mismatch"
        | "approval_expired"
        | "approval_consumed"
        | "approval_version_mismatch"
        | "unknown_tool"
        | "invalid_input";
      message: string;
    };

export async function createPendingApproval(
  db: Queryable,
  params: {
    tenantId: string;
    runId: string;
    toolName: string;
    toolVersion: string;
    resolvedPayload: unknown;
    costEstimate?: string;
    scope?: unknown;
    ttlMs?: number;
  },
): Promise<ToolApprovalRow> {
  const id = uuidv7();
  const operationId = uuidv7();
  const hash = sha256Canonical({
    tool: params.toolName,
    version: params.toolVersion,
    payload: params.resolvedPayload,
  });
  const ttl = params.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const result = await db.query<ToolApprovalRow>(
    `INSERT INTO tool_approval (
       id, tenant_id, run_id, tool_name, tool_version,
       resolved_payload, resolved_request_hash, operation_id,
       cost_estimate, scope, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::jsonb, $7, $8,
       $9, $10::jsonb, now() + ($11 || ' milliseconds')::interval
     )
     RETURNING *`,
    [
      id,
      params.tenantId,
      params.runId,
      params.toolName,
      params.toolVersion,
      JSON.stringify(params.resolvedPayload),
      hash,
      operationId,
      params.costEstimate ?? null,
      params.scope === undefined ? null : JSON.stringify(params.scope),
      ttl,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to insert tool_approval");
  return row;
}

/**
 * Decide an approval (human consent). Does not execute — consume+reserve
 * happens at execution time in one transaction (auftrag §0.1).
 */
export async function decideApproval(
  db: Queryable,
  params: { approvalId: string; tenantId: string; userId: string; approve: boolean },
): Promise<ToolApprovalRow | null> {
  if (!params.approve) {
    const denied = await db.query<ToolApprovalRow>(
      `UPDATE tool_approval
       SET decided_by = $1, decided_at = now(), consumed_at = now()
       WHERE id = $2 AND tenant_id = $3
         AND decided_at IS NULL AND consumed_at IS NULL
         AND expires_at > now()
       RETURNING *`,
      [params.userId, params.approvalId, params.tenantId],
    );
    return denied.rows[0] ?? null;
  }
  const decided = await db.query<ToolApprovalRow>(
    `UPDATE tool_approval
     SET decided_by = $1, decided_at = now()
     WHERE id = $2 AND tenant_id = $3
       AND decided_at IS NULL AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING *`,
    [params.userId, params.approvalId, params.tenantId],
  );
  return decided.rows[0] ?? null;
}

async function reserveFromApproval(
  client: PoolClient,
  approval: ToolApprovalRow,
): Promise<"reserved" | "already_reserved" | "rejected"> {
  if (approval.consumed_at) return "rejected";
  if (new Date(approval.expires_at).getTime() <= Date.now()) return "rejected";
  if (!approval.decided_at || !approval.decided_by) return "rejected";

  const existing = await client.query(
    `SELECT operation_id FROM reserved_operation WHERE operation_id = $1`,
    [approval.operation_id],
  );
  if (existing.rows[0]) return "already_reserved";

  const updated = await client.query(
    `UPDATE tool_approval
     SET consumed_at = now()
     WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING id`,
    [approval.id],
  );
  if (!updated.rows[0]) return "rejected";

  await client.query(
    `INSERT INTO reserved_operation (
       operation_id, tenant_id, tool_name, tool_version,
       resolved_request_hash, resolved_payload, status, approval_id
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'in_flight', $7)`,
    [
      approval.operation_id,
      approval.tenant_id,
      approval.tool_name,
      approval.tool_version,
      approval.resolved_request_hash,
      JSON.stringify(approval.resolved_payload),
      approval.id,
    ],
  );
  return "reserved";
}

/**
 * Execute a tool call. readOnly runs immediately. Anything else requires a
 * decided, unconsumed, unexpired approval whose hash and tool_version match
 * the resolved payload. Retries load the reserved operation *before* any
 * resolve (auftrag §0.1 / Fall 7) — the persisted payload is authoritative.
 */
export async function executeToolCall(
  db: Queryable,
  params: {
    ctx: ToolContext;
    toolName: string;
    rawInput: unknown;
    /** When retrying a previously reserved operation after a network blip. */
    operationId?: string;
    /** Force-create a pending approval instead of rejecting (agent turn). */
    requestApproval?: boolean;
  },
): Promise<ExecuteToolResult> {
  const tool = getTool(params.toolName);
  if (!tool) {
    return { outcome: "rejected", code: "unknown_tool", message: "unknown_tool" };
  }

  // Retry path: load the reservation first — never re-resolve (Review-8 P0-1).
  if (params.operationId) {
    const reserved = await db.query<{
      operation_id: string;
      status: string;
      result: unknown;
      resolved_payload: unknown;
      resolved_request_hash: string;
      tool_version: string;
      tool_name: string;
    }>(
      `SELECT * FROM reserved_operation
       WHERE operation_id = $1 AND tenant_id = $2`,
      [params.operationId, params.ctx.tenantId],
    );
    const row = reserved.rows[0];
    if (!row) {
      return {
        outcome: "rejected",
        code: "approval_required",
        message: "operation_not_found",
      };
    }
    if (row.tool_name !== tool.name) {
      return {
        outcome: "rejected",
        code: "approval_hash_mismatch",
        message: "operation_tool_mismatch",
      };
    }
    if (row.tool_version !== tool.version) {
      return {
        outcome: "rejected",
        code: "approval_version_mismatch",
        message: "operation_version_mismatch",
      };
    }
    if (row.status === "succeeded") {
      return {
        outcome: "executed",
        result: row.result,
        operationId: row.operation_id,
      };
    }
    try {
      const result = await tool.handler(row.resolved_payload, params.ctx);
      await db.query(
        `UPDATE reserved_operation
         SET status = 'succeeded', result = $1::jsonb, completed_at = now()
         WHERE operation_id = $2`,
        [JSON.stringify(result), row.operation_id],
      );
      return { outcome: "executed", result, operationId: row.operation_id };
    } catch (error) {
      await db.query(
        `UPDATE reserved_operation
         SET status = 'failed', completed_at = now()
         WHERE operation_id = $1 AND status = 'in_flight'`,
        [row.operation_id],
      );
      throw error;
    }
  }

  const parsed = tool.inputSchema.safeParse(params.rawInput);
  if (!parsed.success) {
    return { outcome: "rejected", code: "invalid_input", message: parsed.error.message };
  }

  const resolvedPayload = await tool.resolve(parsed.data, params.ctx);
  const resolvedHash = sha256Canonical({
    tool: tool.name,
    version: tool.version,
    payload: resolvedPayload,
  });

  if (tool.sideEffect === "readOnly") {
    const result = await tool.handler(resolvedPayload, params.ctx);
    return { outcome: "executed", result, operationId: uuidv7() };
  }

  // Non-readOnly: find a matching decided approval, or request one.
  const candidates = await db.query<ToolApprovalRow>(
    `SELECT * FROM tool_approval
     WHERE tenant_id = $1 AND run_id = $2 AND tool_name = $3
       AND tool_version = $4
       AND resolved_request_hash = $5
       AND decided_at IS NOT NULL AND decided_by IS NOT NULL
       AND consumed_at IS NULL
       AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1`,
    [params.ctx.tenantId, params.ctx.runId, tool.name, tool.version, resolvedHash],
  );

  let approval = candidates.rows[0];

  if (!approval) {
    // Check whether a consumed/expired one exists for clearer errors (Fall 5–7).
    const prior = await db.query<ToolApprovalRow>(
      `SELECT * FROM tool_approval
       WHERE tenant_id = $1 AND run_id = $2 AND tool_name = $3
       ORDER BY created_at DESC LIMIT 5`,
      [params.ctx.tenantId, params.ctx.runId, tool.name],
    );
    const mismatch = prior.rows.find(
      (row) =>
        row.resolved_request_hash !== resolvedHash || row.tool_version !== tool.version,
    );
    const expired = prior.rows.find(
      (row) =>
        row.resolved_request_hash === resolvedHash &&
        new Date(row.expires_at).getTime() <= Date.now() &&
        !row.consumed_at,
    );
    const consumed = prior.rows.find(
      (row) =>
        row.resolved_request_hash === resolvedHash && row.consumed_at !== null,
    );

    if (params.requestApproval) {
      const pending = await createPendingApproval(db, {
        tenantId: params.ctx.tenantId,
        runId: params.ctx.runId,
        toolName: tool.name,
        toolVersion: tool.version,
        resolvedPayload,
        costEstimate: tool.costClass,
      });
      return { outcome: "needs_approval", approval: pending };
    }

    if (mismatch && mismatch.tool_version !== tool.version) {
      return {
        outcome: "rejected",
        code: "approval_version_mismatch",
        message: "tool_version_mismatch",
      };
    }
    if (mismatch) {
      return {
        outcome: "rejected",
        code: "approval_hash_mismatch",
        message: "resolved_hash_mismatch",
      };
    }
    if (expired) {
      return {
        outcome: "rejected",
        code: "approval_expired",
        message: "approval_expired",
      };
    }
    if (consumed) {
      return {
        outcome: "rejected",
        code: "approval_consumed",
        message: "approval_consumed",
      };
    }
    return {
      outcome: "rejected",
      code: "approval_required",
      message: "approval_required",
    };
  }

  if (approval.tool_version !== tool.version) {
    return {
      outcome: "rejected",
      code: "approval_version_mismatch",
      message: "tool_version_mismatch",
    };
  }
  if (approval.resolved_request_hash !== resolvedHash) {
    return {
      outcome: "rejected",
      code: "approval_hash_mismatch",
      message: "resolved_hash_mismatch",
    };
  }

  const reserveOutcome = await withTransaction(db, async (client) =>
    reserveFromApproval(client, approval),
  );

  if (reserveOutcome === "rejected") {
    // Re-read to classify
    const fresh = await db.query<ToolApprovalRow>(
      `SELECT * FROM tool_approval WHERE id = $1`,
      [approval.id],
    );
    const row = fresh.rows[0];
    if (row?.consumed_at) {
      return {
        outcome: "rejected",
        code: "approval_consumed",
        message: "approval_consumed",
      };
    }
    return {
      outcome: "rejected",
      code: "approval_expired",
      message: "approval_expired",
    };
  }

  try {
    // Execute the *persisted* payload, never the freshly resolved one.
    const result = await tool.handler(approval.resolved_payload, params.ctx);
    await db.query(
      `UPDATE reserved_operation
       SET status = 'succeeded', result = $1::jsonb, completed_at = now()
       WHERE operation_id = $2`,
      [JSON.stringify(result), approval.operation_id],
    );
    return {
      outcome: "executed",
      result,
      operationId: approval.operation_id,
      approvalId: approval.id,
    };
  } catch (error) {
    await db.query(
      `UPDATE reserved_operation
       SET status = 'failed', completed_at = now()
       WHERE operation_id = $1 AND status = 'in_flight'`,
      [approval.operation_id],
    );
    throw error;
  }
}

/**
 * Post-consent worker path: approve already happened; load the persisted
 * payload by approval id and execute it verbatim. Never re-resolves — that
 * would invalidate time-dependent args (auftrag §0.1 / Review-8 P0-1).
 */
export async function executePersistedApproval(
  db: Queryable,
  params: { approvalId: string; tenantId: string; ctx: ToolContext },
): Promise<ExecuteToolResult> {
  const found = await db.query<ToolApprovalRow>(
    `SELECT * FROM tool_approval WHERE id = $1 AND tenant_id = $2`,
    [params.approvalId, params.tenantId],
  );
  const approval = found.rows[0];
  if (!approval) {
    return { outcome: "rejected", code: "approval_required", message: "not_found" };
  }
  const tool = getTool(approval.tool_name);
  if (!tool) {
    return { outcome: "rejected", code: "unknown_tool", message: "unknown_tool" };
  }
  if (tool.version !== approval.tool_version) {
    return {
      outcome: "rejected",
      code: "approval_version_mismatch",
      message: "tool_version_mismatch",
    };
  }

  // Retry via operation_id if already reserved.
  const reserved = await db.query<{ status: string; result: unknown }>(
    `SELECT status, result FROM reserved_operation WHERE operation_id = $1`,
    [approval.operation_id],
  );
  if (reserved.rows[0]?.status === "succeeded") {
    return {
      outcome: "executed",
      result: reserved.rows[0].result,
      operationId: approval.operation_id,
      approvalId: approval.id,
    };
  }
  if (reserved.rows[0]?.status === "in_flight" || reserved.rows[0]?.status === "failed") {
    const result = await tool.handler(approval.resolved_payload, params.ctx);
    await db.query(
      `UPDATE reserved_operation
       SET status = 'succeeded', result = $1::jsonb, completed_at = now()
       WHERE operation_id = $2`,
      [JSON.stringify(result), approval.operation_id],
    );
    return {
      outcome: "executed",
      result,
      operationId: approval.operation_id,
      approvalId: approval.id,
    };
  }

  if (!approval.decided_at) {
    return { outcome: "rejected", code: "approval_required", message: "not_decided" };
  }
  if (approval.consumed_at) {
    return { outcome: "rejected", code: "approval_consumed", message: "approval_consumed" };
  }
  if (new Date(approval.expires_at).getTime() <= Date.now()) {
    return { outcome: "rejected", code: "approval_expired", message: "approval_expired" };
  }

  const reserveOutcome = await withTransaction(db, async (client) =>
    reserveFromApproval(client, approval),
  );
  if (reserveOutcome === "rejected") {
    return { outcome: "rejected", code: "approval_expired", message: "reserve_failed" };
  }

  const result = await tool.handler(approval.resolved_payload, params.ctx);
  await db.query(
    `UPDATE reserved_operation
     SET status = 'succeeded', result = $1::jsonb, completed_at = now()
     WHERE operation_id = $2`,
    [JSON.stringify(result), approval.operation_id],
  );
  return {
    outcome: "executed",
    result,
    operationId: approval.operation_id,
    approvalId: approval.id,
  };
}
