import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { AGENT_SYSTEM_INSTRUCTION, agentTurnFamily } from "@/agent/turn";
import {
  computePromptHash,
} from "@/agent/context-packet";
import { createChatRun } from "@/agent/create-chat-run";
import { ScriptedModel, setAgentModelForTests } from "@/agent/model";
import { resolvePlaybook, PlaybookMissingError, playbookBody } from "@/agent/playbooks/resolve";
import { listRunEventsAfter } from "@/agent/run-events";
import {
  createPendingApproval,
  decideApproval,
  executePersistedApproval,
  executeToolCall,
} from "@/agent/tools/approvals";
import { resetToolsForTests } from "@/agent/tools/bootstrap";
import { registerTool, type ToolContext } from "@/agent/tools/types";
import { hashPlaybookFiles } from "@/lib/canonical-json";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { startWorker } from "@/queue/poll-loop";
import type { JobContext } from "@/queue/types";
import { setPoolForTests } from "@/db/pool";
import { type TestDb, startTestDb } from "./db-harness";

describe("etappe 4 — agent, chat, playbooks", () => {
  let db: TestDb;
  let userId: string;
  let playbookDir: string;
  let resolutionDefault = "A";

  beforeAll(async () => {
    db = await startTestDb();
    setPoolForTests(db.pool);
    ensureQueueBootstrapped();
    resetToolsForTests();

    userId = uuidv7();
    await db.pool.query(
      `INSERT INTO app_user (id, tenant_id, email, role, ui_locale, agent_locale)
       VALUES ($1, $2, $3, 'owner', 'de', 'de')`,
      [userId, db.tenantId, "agent@example.com"],
    );

    playbookDir = join(tmpdir(), `adloop-playbooks-${uuidv7()}`);
    await mkdir(join(playbookDir, "general"), { recursive: true });
    await writeFile(
      join(playbookDir, "general", "PLAYBOOK.md"),
      "# Dir playbook\nFrom PLAYBOOK_DIR.\n",
      "utf8",
    );
    process.env.PLAYBOOK_DIR = playbookDir;

    // Mutable resolve default — Fall 5: same raw args, changed resolution.
    registerTool({
      name: "writes_probe",
      version: "1",
      description: "test writesInternal probe",
      inputSchema: z.object({ label: z.string() }),
      kind: "sync",
      costClass: "cheap",
      sideEffect: "writesInternal",
      resolve: (raw: unknown) => {
        const parsed = z.object({ label: z.string() }).parse(raw);
        return {
          label: parsed.label,
          resolvedDefault: resolutionDefault,
        };
      },
      handler: async (resolved) => ({ ok: true, resolved }),
    });
  }, 60_000);

  afterAll(async () => {
    setAgentModelForTests(null);
    setPoolForTests(null);
    await rm(playbookDir, { recursive: true, force: true });
    delete process.env.PLAYBOOK_DIR;
    await db.stop();
  });

  beforeEach(() => {
    resolutionDefault = "A";
    setAgentModelForTests(null);
  });

  function toolCtx(runId: string): ToolContext {
    return {
      tenantId: db.tenantId,
      userId,
      runId,
      signal: new AbortController().signal,
      agentLocale: "de",
    };
  }

  async function seedChat(): Promise<string> {
    const projectId = uuidv7();
    const chatId = uuidv7();
    await db.pool.query(
      `INSERT INTO project (id, tenant_id, name) VALUES ($1, $2, 'P')`,
      [projectId, db.tenantId],
    );
    await db.pool.query(
      `INSERT INTO chat (id, tenant_id, project_id, name) VALUES ($1, $2, $3, 'C')`,
      [chatId, db.tenantId, projectId],
    );
    return chatId;
  }

  async function seedTurnRun(params: {
    chatId: string;
    runId: string;
    userMessageId: string;
    assistantMessageId: string;
    message: string;
  }): Promise<void> {
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, chat_id, input, turn_phase)
       VALUES ($1, $2, 'agent_turn', 'queued', $3, '{}'::jsonb, 'queued')`,
      [params.runId, db.tenantId, params.chatId],
    );
    await db.pool.query(
      `INSERT INTO message (id, tenant_id, chat_id, role, content, run_id)
       VALUES ($1, $2, $3, 'user', $4, $5)`,
      [
        params.userMessageId,
        db.tenantId,
        params.chatId,
        params.message,
        params.runId,
      ],
    );
    await db.pool.query(
      `INSERT INTO message (id, tenant_id, chat_id, role, content, run_id)
       VALUES ($1, $2, $3, 'assistant', '', $4)`,
      [params.assistantMessageId, db.tenantId, params.chatId, params.runId],
    );
  }

  function turnCtx(
    input: {
      runId: string;
      chatId: string;
      userMessageId: string;
      assistantMessageId: string;
      message: string;
      playbookSlug: string;
      agentLocale: "de" | "en";
      userId: string;
    },
    signal: AbortSignal,
  ): JobContext<typeof input> {
    return {
      input,
      tenantId: db.tenantId,
      signal,
      progress: async () => {},
      withLease: async () => ({ acquired: false }),
      isCancelled: () => signal.aborted,
    };
  }

  it("1 — turn runs through phases and ends with terminal/[DONE] payload", async () => {
    const chatId = await seedChat();
    const runId = uuidv7();
    setAgentModelForTests(
      new ScriptedModel([{ text: "Hallo aus dem Fixture-Playbook.", toolUses: [] }]),
    );

    const created = await createChatRun(db.pool, {
      runId,
      tenantId: db.tenantId,
      userId,
      chatId,
      userMessageId: uuidv7(),
      assistantMessageId: uuidv7(),
      message: "Status?",
      playbookSlug: "general",
      agentLocale: "de",
    });
    expect(created.outcome).toBe("created");

    const worker = startWorker({
      pool: db.pool,
      connectionString: db.databaseUrl,
      workerId: `t4-1-${uuidv7()}`,
      pollIntervalMs: 100,
      leaseMs: 10_000,
      heartbeatIntervalMs: 1_000,
      concurrency: 1,
      shutdownGraceMs: 2_000,
    });

    const deadline = Date.now() + 15_000;
    let phases: string[] = [];
    while (Date.now() < deadline) {
      const events = await listRunEventsAfter(db.pool, { runId, afterSeq: 0 });
      phases = events
        .filter((e) => e.kind === "turn_phase")
        .map((e) => (e.payload as { phase: string }).phase);
      if (events.some((e) => e.kind === "terminal")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.shutdown();

    const expectedOrder = [
      "queued",
      "claimed",
      "assembling_context",
      "invoking_model",
      "streaming",
      "finalizing",
      "completed",
    ];
    let cursor = 0;
    for (const phase of expectedOrder) {
      const idx = phases.indexOf(phase, cursor);
      expect(idx, `missing phase ${phase} in ${phases.join(",")}`).toBeGreaterThanOrEqual(0);
      cursor = idx;
    }
    const terminal = await listRunEventsAfter(db.pool, { runId, afterSeq: 0 });
    expect(terminal.some((e) => e.kind === "terminal")).toBe(true);
  }, 30_000);

  it("2 — reconnect with after=seq replays only later events", async () => {
    const chatId = await seedChat();
    const runId = uuidv7();
    setAgentModelForTests(new ScriptedModel([{ text: "reconnect-ok", toolUses: [] }]));
    await createChatRun(db.pool, {
      runId,
      tenantId: db.tenantId,
      userId,
      chatId,
      userMessageId: uuidv7(),
      assistantMessageId: uuidv7(),
      message: "hi",
      playbookSlug: "general",
      agentLocale: "de",
    });
    const worker = startWorker({
      pool: db.pool,
      connectionString: db.databaseUrl,
      workerId: `t4-2-${uuidv7()}`,
      pollIntervalMs: 100,
      leaseMs: 10_000,
      heartbeatIntervalMs: 1_000,
      concurrency: 1,
      shutdownGraceMs: 2_000,
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const events = await listRunEventsAfter(db.pool, { runId, afterSeq: 0 });
      if (events.some((e) => e.kind === "terminal")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.shutdown();

    const all = await listRunEventsAfter(db.pool, { runId, afterSeq: 0 });
    expect(all.length).toBeGreaterThan(2);
    const mid = Number(all[1]!.seq);
    const resumed = await listRunEventsAfter(db.pool, { runId, afterSeq: mid });
    expect(resumed.every((e) => Number(e.seq) > mid)).toBe(true);
    expect(resumed.length).toBe(all.length - 2);
  }, 30_000);

  it("3 — readOnly runs without approval", async () => {
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input) VALUES ($1, $2, 'agent_turn', 'queued', '{}')`,
      [runId, db.tenantId],
    );
    const result = await executeToolCall(db.pool, {
      ctx: toolCtx(runId),
      toolName: "get_job_status",
      rawInput: { runId },
    });
    expect(result.outcome).toBe("executed");
  });

  it("4 — writesInternal without approval is rejected", async () => {
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input) VALUES ($1, $2, 'agent_turn', 'queued', '{}')`,
      [runId, db.tenantId],
    );
    const result = await executeToolCall(db.pool, {
      ctx: toolCtx(runId),
      toolName: "writes_probe",
      rawInput: { label: "x" },
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.code).toBe("approval_required");
    }
  });

  it("5 — same raw args, resolution changes to B: persisted payload A is executed", async () => {
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input) VALUES ($1, $2, 'agent_turn', 'queued', '{}')`,
      [runId, db.tenantId],
    );
    resolutionDefault = "A";
    const pending = await executeToolCall(db.pool, {
      ctx: toolCtx(runId),
      toolName: "writes_probe",
      rawInput: { label: "same" },
      requestApproval: true,
    });
    expect(pending.outcome).toBe("needs_approval");
    if (pending.outcome !== "needs_approval") return;

    await decideApproval(db.pool, {
      approvalId: pending.approval.id,
      tenantId: db.tenantId,
      userId,
      approve: true,
    });

    // Same raw args; resolve would now yield B. Production path must still
    // execute the persisted payload A (auftrag §0.1 / Review-8 P0-1).
    resolutionDefault = "B";
    const executed = await executePersistedApproval(db.pool, {
      approvalId: pending.approval.id,
      tenantId: db.tenantId,
      ctx: toolCtx(runId),
    });
    expect(executed.outcome).toBe("executed");
    if (executed.outcome === "executed") {
      expect(executed.result).toEqual({
        ok: true,
        resolved: { label: "same", resolvedDefault: "A" },
      });
    }
  });

  it("5b — re-resolve path rejects when trying to consume approval with payload B", async () => {
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input) VALUES ($1, $2, 'agent_turn', 'queued', '{}')`,
      [runId, db.tenantId],
    );
    resolutionDefault = "A";
    const pending = await executeToolCall(db.pool, {
      ctx: toolCtx(runId),
      toolName: "writes_probe",
      rawInput: { label: "mismatch" },
      requestApproval: true,
    });
    expect(pending.outcome).toBe("needs_approval");
    if (pending.outcome !== "needs_approval") return;

    await decideApproval(db.pool, {
      approvalId: pending.approval.id,
      tenantId: db.tenantId,
      userId,
      approve: true,
    });

    // Caller tries to consume via freshly resolved B — hash must not match.
    resolutionDefault = "B";
    const rejected = await executeToolCall(db.pool, {
      ctx: toolCtx(runId),
      toolName: "writes_probe",
      rawInput: { label: "mismatch" },
    });
    expect(rejected.outcome).toBe("rejected");
    if (rejected.outcome === "rejected") {
      expect(rejected.code).toBe("approval_hash_mismatch");
    }
  });

  it("5c — agentTurnFamily.handler executes persisted A after resolution flips to B", async () => {
    // Load-bearing: drives the real turn path. Must fail if turn.ts reverts to
    // executeToolCall(rawInput) after consent (Review-8 P0-1 acceptance).
    const chatId = await seedChat();
    const runId = uuidv7();
    const userMessageId = uuidv7();
    const assistantMessageId = uuidv7();
    const message = "please write";
    await seedTurnRun({ chatId, runId, userMessageId, assistantMessageId, message });

    resolutionDefault = "A";
    setAgentModelForTests(
      new ScriptedModel([
        {
          toolUses: [
            { id: "tu-1", name: "writes_probe", input: { label: "same" } },
          ],
        },
        { text: "Persisted A executed." },
      ]),
    );

    const controller = new AbortController();
    const turnPromise = agentTurnFamily.handler(
      turnCtx(
        {
          runId,
          chatId,
          userMessageId,
          assistantMessageId,
          message,
          playbookSlug: "general",
          agentLocale: "de",
          userId,
        },
        controller.signal,
      ),
    );

    const approvalDeadline = Date.now() + 10_000;
    let approvalId: string | null = null;
    while (Date.now() < approvalDeadline) {
      const pending = await db.pool.query<{
        id: string;
        resolved_payload: { label: string; resolvedDefault: string };
      }>(
        `SELECT id, resolved_payload
         FROM tool_approval
         WHERE run_id = $1 AND decided_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [runId],
      );
      if (pending.rows[0]) {
        approvalId = pending.rows[0].id;
        expect(pending.rows[0].resolved_payload).toEqual({
          label: "same",
          resolvedDefault: "A",
        });
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(approvalId).toBeTruthy();

    // Midnight flips the resolver — production must still run payload A.
    resolutionDefault = "B";
    await decideApproval(db.pool, {
      approvalId: approvalId!,
      tenantId: db.tenantId,
      userId,
      approve: true,
    });

    const result = await turnPromise;
    expect(result.text).toBe("Persisted A executed.");

    const reserved = await db.pool.query<{
      resolved_payload: { resolvedDefault: string };
      result: { ok: boolean; resolved: { resolvedDefault: string } };
    }>(
      `SELECT resolved_payload, result
       FROM reserved_operation
       WHERE approval_id = $1`,
      [approvalId],
    );
    expect(reserved.rows[0]?.resolved_payload.resolvedDefault).toBe("A");
    expect(reserved.rows[0]?.result.resolved.resolvedDefault).toBe("A");

    const terminal = await listRunEventsAfter(db.pool, { runId, afterSeq: 0 });
    expect(
      terminal.some(
        (e) =>
          e.kind === "terminal" &&
          (e.payload as { status?: string }).status === "completed",
      ),
    ).toBe(true);
  }, 30_000);

  it("5d — abort mid-turn persists a terminal event", async () => {
    const chatId = await seedChat();
    const runId = uuidv7();
    const userMessageId = uuidv7();
    const assistantMessageId = uuidv7();
    const message = "abort me";
    await seedTurnRun({ chatId, runId, userMessageId, assistantMessageId, message });

    resolutionDefault = "A";
    setAgentModelForTests(
      new ScriptedModel([
        {
          toolUses: [
            { id: "tu-abort", name: "writes_probe", input: { label: "abort" } },
          ],
        },
      ]),
    );

    const controller = new AbortController();
    const turnPromise = agentTurnFamily.handler(
      turnCtx(
        {
          runId,
          chatId,
          userMessageId,
          assistantMessageId,
          message,
          playbookSlug: "general",
          agentLocale: "de",
          userId,
        },
        controller.signal,
      ),
    );

    const phaseDeadline = Date.now() + 10_000;
    while (Date.now() < phaseDeadline) {
      const phase = await db.pool.query<{ turn_phase: string | null }>(
        `SELECT turn_phase FROM run WHERE id = $1`,
        [runId],
      );
      if (phase.rows[0]?.turn_phase === "awaiting_approval") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    controller.abort();
    await expect(turnPromise).rejects.toMatchObject({
      name: "HandlerError",
      code: "APPROVAL_TIMEOUT",
    });

    const events = await listRunEventsAfter(db.pool, { runId, afterSeq: 0 });
    const terminal = events.find((e) => e.kind === "terminal");
    expect(terminal).toBeDefined();
    expect(terminal?.payload).toMatchObject({
      kind: "terminal",
      status: "failed",
      errorCode: "approval_timeout",
    });
  }, 30_000);

  it("6 — expired approval is rejected", async () => {
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input) VALUES ($1, $2, 'agent_turn', 'queued', '{}')`,
      [runId, db.tenantId],
    );
    const approval = await createPendingApproval(db.pool, {
      tenantId: db.tenantId,
      runId,
      toolName: "writes_probe",
      toolVersion: "1",
      resolvedPayload: { label: "x", resolvedDefault: "A" },
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    await db.pool.query(
      `UPDATE tool_approval SET decided_by = $1, decided_at = now() WHERE id = $2`,
      [userId, approval.id],
    );
    // Force expiry in DB in case clock granularity is coarse.
    await db.pool.query(
      `UPDATE tool_approval SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [approval.id],
    );
    resolutionDefault = "A";
    const result = await executeToolCall(db.pool, {
      ctx: toolCtx(runId),
      toolName: "writes_probe",
      rawInput: { label: "x" },
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.code).toBe("approval_expired");
    }
  });

  it("7 — consumed approval rejected; retry of same operation_id continues without re-resolve", async () => {
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input) VALUES ($1, $2, 'agent_turn', 'queued', '{}')`,
      [runId, db.tenantId],
    );
    resolutionDefault = "A";
    const pending = await executeToolCall(db.pool, {
      ctx: toolCtx(runId),
      toolName: "writes_probe",
      rawInput: { label: "retry" },
      requestApproval: true,
    });
    expect(pending.outcome).toBe("needs_approval");
    if (pending.outcome !== "needs_approval") return;

    await decideApproval(db.pool, {
      approvalId: pending.approval.id,
      tenantId: db.tenantId,
      userId,
      approve: true,
    });

    // Production post-consent path (same helper the turn uses).
    const first = await executePersistedApproval(db.pool, {
      approvalId: pending.approval.id,
      tenantId: db.tenantId,
      ctx: toolCtx(runId),
    });
    expect(first.outcome).toBe("executed");
    if (first.outcome !== "executed") return;

    const consumed = await executeToolCall(db.pool, {
      ctx: toolCtx(runId),
      toolName: "writes_probe",
      rawInput: { label: "retry" },
    });
    expect(consumed.outcome).toBe("rejected");
    if (consumed.outcome === "rejected") {
      expect(consumed.code).toBe("approval_consumed");
    }

    // Resolution changed after reserve — retry must still run persisted A.
    resolutionDefault = "B";
    const retried = await executeToolCall(db.pool, {
      ctx: toolCtx(runId),
      toolName: "writes_probe",
      rawInput: { label: "retry" },
      operationId: first.operationId,
    });
    expect(retried.outcome).toBe("executed");
    if (retried.outcome === "executed") {
      expect(retried.result).toEqual({
        ok: true,
        resolved: { label: "retry", resolvedDefault: "A" },
      });
    }
  });

  it("8 — missing playbook in production does not fall back to fixture", async () => {
    const previous = process.env.NODE_ENV;
    const previousDir = process.env.PLAYBOOK_DIR;
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    delete process.env.PLAYBOOK_DIR;
    try {
      await expect(
        resolvePlaybook(db.pool, { tenantId: db.tenantId, slug: "general" }),
      ).rejects.toBeInstanceOf(PlaybookMissingError);
    } finally {
      (process.env as { NODE_ENV?: string }).NODE_ENV = previous;
      if (previousDir) process.env.PLAYBOOK_DIR = previousDir;
    }
  });

  it("9 — DB override wins over PLAYBOOK_DIR", async () => {
    process.env.PLAYBOOK_DIR = playbookDir;
    await db.pool.query(
      `UPDATE playbook_override SET active = false
       WHERE tenant_id = $1 AND playbook_slug = 'general'`,
      [db.tenantId],
    );
    const fromDir = await resolvePlaybook(db.pool, {
      tenantId: db.tenantId,
      slug: "general",
    });
    expect(fromDir.source).toBe("dir");

    const files = { "PLAYBOOK.md": "# DB override wins\n" };
    await db.pool.query(
      `INSERT INTO playbook_override (
         id, tenant_id, playbook_slug, version, files, content_hash, author_id, active
       ) VALUES ($1, $2, 'general', 1, $3::jsonb, $4, $5, true)`,
      [uuidv7(), db.tenantId, JSON.stringify(files), hashPlaybookFiles(files), userId],
    );

    const resolved = await resolvePlaybook(db.pool, {
      tenantId: db.tenantId,
      slug: "general",
    });
    expect(resolved.source).toBe("db");
    expect(resolved.files["PLAYBOOK.md"]).toContain("DB override wins");
  });

  it("10 — context packet persisted; prompt_hash matches full model request", async () => {
    const chatId = await seedChat();
    const runId = uuidv7();
    const message = "Paket bitte";
    setAgentModelForTests(new ScriptedModel([{ text: "ok", toolUses: [] }]));
    await createChatRun(db.pool, {
      runId,
      tenantId: db.tenantId,
      userId,
      chatId,
      userMessageId: uuidv7(),
      assistantMessageId: uuidv7(),
      message,
      playbookSlug: "general",
      agentLocale: "de",
    });
    const worker = startWorker({
      pool: db.pool,
      connectionString: db.databaseUrl,
      workerId: `t4-10-${uuidv7()}`,
      pollIntervalMs: 100,
      leaseMs: 10_000,
      heartbeatIntervalMs: 1_000,
      concurrency: 1,
      shutdownGraceMs: 2_000,
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const row = await db.pool.query<{
        context_packet: string | null;
        prompt_hash: string | null;
      }>(`SELECT context_packet, prompt_hash FROM run WHERE id = $1`, [runId]);
      if (row.rows[0]?.prompt_hash) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.shutdown();

    const stored = await db.pool.query<{
      context_packet: string;
      prompt_hash: string;
      playbook_version: string;
    }>(
      `SELECT context_packet, prompt_hash, playbook_version FROM run WHERE id = $1`,
      [runId],
    );
    const row = stored.rows[0]!;
    expect(row.context_packet).toContain("Performance window:");
    expect(row.context_packet).toContain("Agent locale: de");
    expect(row.context_packet).toContain("Content locale:");
    expect(row.context_packet).toMatch(/no_ad_account_selected|no_sync_completed|no_metrics_selected/);
    expect(row.prompt_hash).toMatch(/^[a-f0-9]{64}$/);

    const playbook = await resolvePlaybook(db.pool, {
      tenantId: db.tenantId,
      slug: "general",
    });
    const expected = computePromptHash({
      systemInstruction: AGENT_SYSTEM_INSTRUCTION,
      playbookContent: playbookBody(playbook),
      contextPacket: row.context_packet,
      userMessage: message,
    });
    expect(row.prompt_hash).toBe(expected);
  }, 30_000);

  it("11 — playbook_version contains source and content hash", async () => {
    const chatId = await seedChat();
    const runId = uuidv7();
    setAgentModelForTests(new ScriptedModel([{ text: "v", toolUses: [] }]));
    // Prefer dir source for this assertion (clear DB overrides).
    await db.pool.query(
      `UPDATE playbook_override SET active = false
       WHERE tenant_id = $1 AND playbook_slug = 'general'`,
      [db.tenantId],
    );
    process.env.PLAYBOOK_DIR = playbookDir;
    await createChatRun(db.pool, {
      runId,
      tenantId: db.tenantId,
      userId,
      chatId,
      userMessageId: uuidv7(),
      assistantMessageId: uuidv7(),
      message: "version?",
      playbookSlug: "general",
      agentLocale: "de",
    });
    const worker = startWorker({
      pool: db.pool,
      connectionString: db.databaseUrl,
      workerId: `t4-11-${uuidv7()}`,
      pollIntervalMs: 100,
      leaseMs: 10_000,
      heartbeatIntervalMs: 1_000,
      concurrency: 1,
      shutdownGraceMs: 2_000,
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const row = await db.pool.query<{ playbook_version: string | null }>(
        `SELECT playbook_version FROM run WHERE id = $1`,
        [runId],
      );
      if (row.rows[0]?.playbook_version) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.shutdown();
    const version = (
      await db.pool.query<{ playbook_version: string }>(
        `SELECT playbook_version FROM run WHERE id = $1`,
        [runId],
      )
    ).rows[0]!.playbook_version;
    expect(version).toMatch(/^(dir|db|fixture):[a-f0-9]{64}$/);
  }, 30_000);

  it("idempotent chat runId replay vs conflict", async () => {
    const chatId = await seedChat();
    const runId = uuidv7();
    const body = {
      runId,
      tenantId: db.tenantId,
      userId,
      chatId,
      userMessageId: uuidv7(),
      assistantMessageId: uuidv7(),
      message: "same",
      playbookSlug: "general" as const,
      agentLocale: "de" as const,
    };
    expect((await createChatRun(db.pool, body)).outcome).toBe("created");
    expect((await createChatRun(db.pool, body)).outcome).toBe("idempotent_replay");
    expect(
      (
        await createChatRun(db.pool, {
          ...body,
          message: "different",
        })
      ).outcome,
    ).toBe("conflict");
  });
});
