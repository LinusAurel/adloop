import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { uuidv7 } from "uuidv7";
import { assembleContextPacket } from "@/agent/context-packet";
import { createChatRun } from "@/agent/create-chat-run";
import { ScriptedModel, setAgentModelForTests } from "@/agent/model";
import { appendRunEvent, listRunEventsAfter } from "@/agent/run-events";
import { POST as postPlaybookOverride } from "@/app/api/playbooks/overrides/route";
import {
  createSession,
  encodeSession,
  SESSION_COOKIE,
} from "@/auth/session";
import { setPoolForTests } from "@/db/pool";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { startWorker } from "@/queue/poll-loop";
import {
  acquireTwoDistinctClients,
  createBarrier,
  startTestDb,
  type TestDb,
} from "./db-harness";
import {
  seedAccountWindow,
  seedDailyRows,
  seedMetaAccount,
  seedSucceededSync,
  seedWindow,
} from "./metrics-fixtures";

describe("review-8 adversarial fixes", () => {
  let db: TestDb;
  let ownerId: string;
  let memberId: string;

  beforeAll(async () => {
    db = await startTestDb();
    setPoolForTests(db.pool);
    ensureQueueBootstrapped();

    ownerId = uuidv7();
    memberId = uuidv7();
    await db.pool.query(
      `INSERT INTO app_user (id, tenant_id, email, role, ui_locale, agent_locale)
       VALUES ($1, $2, 'owner-r8@example.com', 'owner', 'de', 'en')`,
      [ownerId, db.tenantId],
    );
    await db.pool.query(
      `INSERT INTO app_user (id, tenant_id, email, role, ui_locale, agent_locale)
       VALUES ($1, $2, 'member-r8@example.com', 'member', 'de', 'de')`,
      [memberId, db.tenantId],
    );
  }, 60_000);

  afterAll(async () => {
    setAgentModelForTests(null);
    setPoolForTests(null);
    await db.stop();
  });

  beforeEach(() => {
    setAgentModelForTests(null);
  });

  async function seedChat(): Promise<string> {
    const projectId = uuidv7();
    const chatId = uuidv7();
    await db.pool.query(
      `INSERT INTO project (id, tenant_id, name) VALUES ($1, $2, 'R8')`,
      [projectId, db.tenantId],
    );
    await db.pool.query(
      `INSERT INTO chat (id, tenant_id, project_id, name) VALUES ($1, $2, $3, 'R8')`,
      [chatId, db.tenantId, projectId],
    );
    return chatId;
  }

  it("P0-2 — concurrent appendRunEvent on distinct backends yields gapless seq", async () => {
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input)
       VALUES ($1, $2, 'agent_turn', 'queued', '{}')`,
      [runId, db.tenantId],
    );

    const { clientA, pidA, clientB, pidB, release } =
      await acquireTwoDistinctClients(db.pool);
    expect(pidA).not.toBe(pidB);

    try {
      const barrier = createBarrier(2);
      const [a, b] = await Promise.all([
        (async () => {
          await barrier.arrive();
          return appendRunEvent(clientA, {
            runId,
            kind: "delta",
            payload: { kind: "delta", text: "a", messageId: uuidv7() },
          });
        })(),
        (async () => {
          await barrier.arrive();
          return appendRunEvent(clientB, {
            runId,
            kind: "delta",
            payload: { kind: "delta", text: "b", messageId: uuidv7() },
          });
        })(),
      ]);

      const seqs = [Number(a.seq), Number(b.seq)].sort((x, y) => x - y);
      expect(seqs).toEqual([1, 2]);
    } finally {
      release();
    }

    const all = await listRunEventsAfter(db.pool, { runId, afterSeq: 0 });
    expect(all.map((e) => Number(e.seq))).toEqual([1, 2]);
  });

  it("P1-3 — model failure persists a terminal event", async () => {
    const chatId = await seedChat();
    const runId = uuidv7();
    setAgentModelForTests({
      async complete() {
        throw new Error("model_boom");
      },
    });

    await createChatRun(db.pool, {
      runId,
      tenantId: db.tenantId,
      userId: ownerId,
      chatId,
      userMessageId: uuidv7(),
      assistantMessageId: uuidv7(),
      message: "fail please",
      playbookSlug: "general",
      agentLocale: "de",
    });

    const worker = startWorker({
      pool: db.pool,
      connectionString: db.databaseUrl,
      workerId: `r8-term-${uuidv7()}`,
      pollIntervalMs: 100,
      leaseMs: 10_000,
      heartbeatIntervalMs: 1_000,
      concurrency: 1,
      shutdownGraceMs: 2_000,
    });

    const deadline = Date.now() + 15_000;
    let terminal: { kind: string; payload: unknown } | undefined;
    while (Date.now() < deadline) {
      const events = await listRunEventsAfter(db.pool, { runId, afterSeq: 0 });
      terminal = events.find((e) => e.kind === "terminal");
      if (terminal) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.shutdown();

    expect(terminal).toBeDefined();
    expect(terminal?.payload).toMatchObject({
      kind: "terminal",
      status: "failed",
      errorCode: "uncaught_exception",
    });
  }, 30_000);

  it("P1-4 — stored agent_locale is used when request omits it", async () => {
    const chatId = await seedChat();
    const runId = uuidv7();
    const created = await createChatRun(db.pool, {
      runId,
      tenantId: db.tenantId,
      userId: ownerId,
      chatId,
      userMessageId: uuidv7(),
      assistantMessageId: uuidv7(),
      message: "locale?",
      playbookSlug: "general",
      // agentLocale intentionally omitted — owner has agent_locale=en
    });
    expect(created.outcome).toBe("created");

    const job = await db.pool.query<{ input: { agentLocale: string } }>(
      `SELECT input FROM job WHERE run_id = $1`,
      [runId],
    );
    expect(job.rows[0]?.input.agentLocale).toBe("en");
  });

  it("P1-5 — context packet carries resolved metrics, not silent empty n/a", async () => {
    const account = await seedMetaAccount(db.pool, db.tenantId, "EUR");
    const windowStart = "2026-07-05";
    const windowEnd = "2026-07-05";
    const syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart,
      windowEnd,
      finishedAt: new Date("2026-07-20T12:00:00.000Z"),
    });
    const metaAdId = "ad_r8_metrics";
    await seedDailyRows(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      observedAt: new Date("2026-07-10T12:00:00.000Z"),
      rows: [
        {
          metaAdId,
          date: "2026-07-05",
          spend: 42,
          impressions: 1000,
          clicks: 50,
          reach: 800,
          frequency: 1.25,
        },
      ],
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId,
      windowStart,
      windowEnd,
      reach: 800,
      frequency: 1.25,
      impressions: 1000,
      spend: 42,
      observedAt: new Date("2026-07-10T12:00:00.000Z"),
    });
    await seedAccountWindow(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      syncRunId,
      windowStart,
      windowEnd,
      reach: 800,
      frequency: 1.25,
      impressions: 1000,
      spend: 42,
      observedAt: new Date("2026-07-10T12:00:00.000Z"),
    });

    const { packet, dataAsOf } = await assembleContextPacket(db.pool, {
      tenantId: db.tenantId,
      agentLocale: "de",
      contentLocale: "de-DE",
      windowStart,
      windowEnd,
    });

    expect(dataAsOf).toBeTruthy();
    expect(packet).toContain("Spend: 42");
    expect(packet).toContain("Impressions: 1000");
    expect(packet).toContain("Clicks: 50");
    expect(packet).not.toMatch(/Data gate reasons: no_ad_account_selected/);
  });

  it("P1-5b — missing account is a named gate reason", async () => {
    // Use a fresh tenant with no selected account.
    const tenantId = uuidv7();
    await db.pool.query(`INSERT INTO tenant (id, name) VALUES ($1, 'empty')`, [
      tenantId,
    ]);
    const { packet, dataAsOf } = await assembleContextPacket(db.pool, {
      tenantId,
      agentLocale: "de",
      contentLocale: "de-DE",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-10",
    });
    expect(dataAsOf).toBeNull();
    expect(packet).toContain("no_ad_account_selected");
  });

  it("P1-6 — member without editPlaybooks cannot POST overrides", async () => {
    const session = createSession(memberId, db.tenantId);
    const request = new NextRequest("http://localhost/api/playbooks/overrides", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${encodeSession(session)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        playbookSlug: "general",
        files: { "PLAYBOOK.md": "# no\n" },
      }),
    });
    const response = await postPlaybookOverride(request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
  });
});
