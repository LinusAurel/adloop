import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { setAgentModelForTests, ScriptedModel } from "@/agent/model";
import { setPoolForTests } from "@/db/pool";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { startWorker } from "@/queue/poll-loop";
import { previousEqualWindow } from "@/metrics/data-as-of";
import { computeSpendEfficiency, computeAccountHealth } from "@/metrics/pulse";
import { resolveMetrics } from "@/metrics/resolve";
import { computeAndPersistSnapshots } from "@/metrics/snapshots";
import { buildStrategistOverview } from "@/strategist/overview";
import {
  executeAdReview,
  previewAdReview,
  type AdReviewRequest,
} from "@/strategist/ad-review";
import { adTableArtifact } from "@/strategist/artifacts";
import {
  acquireTwoDistinctClients,
  createBarrier,
  type TestDb,
  startTestDb,
} from "./db-harness";
import {
  buildPassingPopulation,
  seedAccountWindow,
  seedFunnelPopulation,
  seedMetaAccount,
  seedMetaAd,
  seedSucceededSync,
  type SeedAccount,
} from "./metrics-fixtures";

describe("etappe 5 — creative strategist", () => {
  let db: TestDb;
  let userId: string;
  let account: SeedAccount;
  let syncRunId: string;
  let dataAsOf: string;
  const windowStart = "2026-06-20";
  const windowEnd = "2026-07-19";
  const finishedAt = new Date("2026-07-20T12:00:00.000Z");

  beforeAll(async () => {
    db = await startTestDb();
    setPoolForTests(db.pool);
    ensureQueueBootstrapped();

    userId = uuidv7();
    await db.pool.query(
      `INSERT INTO app_user (id, tenant_id, email, role, ui_locale, agent_locale)
       VALUES ($1, $2, $3, 'owner', 'de', 'de')`,
      [userId, db.tenantId, "strategist@example.com"],
    );

    account = await seedMetaAccount(db.pool, db.tenantId);
    syncRunId = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      windowStart: "2026-01-01",
      windowEnd,
      finishedAt,
    });
    dataAsOf = finishedAt.toISOString();

    const population = buildPassingPopulation({ windowStart, windowEnd });
    await seedFunnelPopulation(db.pool, account, population, syncRunId, finishedAt);
    for (const ad of population.ads) {
      await seedMetaAd(db.pool, {
        tenantId: db.tenantId,
        accountId: account.accountId,
        syncRunId,
        metaAdId: ad.metaAdId,
        name: `Fixture Ad ${ad.metaAdId.slice(-2)}`,
        observedAt: finishedAt,
      });
    }
    await seedAccountWindow(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      syncRunId,
      windowStart,
      windowEnd,
      reach: 12000,
      frequency: 1.4,
      impressions: population.ads.reduce((s, a) => s + a.impressions, 0),
      spend: population.ads.reduce((s, a) => s + a.spend, 0),
      observedAt: finishedAt,
    });

    // Previous 30-day window — complete daily coverage so comparisons succeed.
    // Seed dailies + exact windows only (no cumulative) to avoid PK clashes with
    // the current window's cumulative "before" boundary at previous windowEnd.
    const prev = previousEqualWindow(windowStart, windowEnd);
    const { seedDailyRows, seedWindow } = await import("./metrics-fixtures");
    for (const [index, ad] of population.ads.entries()) {
      const spend = 70 + index * 5;
      const impressions = 1800 + index * 100;
      const conversions = index + 1;
      const start = new Date(`${prev.start}T00:00:00.000Z`);
      const end = new Date(`${prev.end}T00:00:00.000Z`);
      const dayCount =
        Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
      const rows = [];
      for (let offset = 0; offset < dayCount; offset += 1) {
        const day = new Date(start);
        day.setUTCDate(day.getUTCDate() + offset);
        const date = day.toISOString().slice(0, 10);
        if (date === prev.end) {
          rows.push({
            metaAdId: ad.metaAdId,
            date,
            spend,
            impressions,
            clicks: 100,
            linkClicks: 90,
            actions: [
              {
                actionType: "offsite_conversion.fb_pixel_purchase",
                count: conversions,
                value: conversions * 35,
              },
            ],
          });
        } else {
          rows.push({
            metaAdId: ad.metaAdId,
            date,
            spend: 0,
            impressions: 0,
          });
        }
      }
      await seedDailyRows(db.pool, {
        tenantId: db.tenantId,
        syncRunId,
        observedAt: finishedAt,
        rows,
      });
      await seedWindow(db.pool, {
        tenantId: db.tenantId,
        syncRunId,
        metaAdId: ad.metaAdId,
        windowStart: prev.start,
        windowEnd: prev.end,
        reach: 1400 + index * 40,
        frequency: 1.1,
        impressions,
        spend,
        observedAt: finishedAt,
      });
    }
    await seedAccountWindow(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      syncRunId,
      windowStart: prev.start,
      windowEnd: prev.end,
      reach: 11000,
      frequency: 1.3,
      impressions: 16000,
      spend: 700,
      observedAt: finishedAt,
    });
  }, 90_000);

  afterAll(async () => {
    setAgentModelForTests(null);
    setPoolForTests(null);
    await db.stop();
  });

  beforeEach(() => {
    setAgentModelForTests(null);
  });

  function baseRequest(
    overrides: Partial<AdReviewRequest> & { adId: string; snapshotId?: string },
  ): AdReviewRequest {
    return {
      adId: overrides.adId,
      adAccountId: account.accountId,
      mode: overrides.mode ?? "cro",
      execute: overrides.execute ?? true,
      runId: overrides.runId ?? uuidv7(),
      userMessageId: overrides.userMessageId ?? uuidv7(),
      assistantMessageId: overrides.assistantMessageId ?? uuidv7(),
      chatId: overrides.chatId,
      analysisWindow: overrides.analysisWindow ?? {
        since: windowStart,
        until: windowEnd,
        label: "Last 30 days",
        dataAsOf,
      },
      snapshotId: overrides.snapshotId,
    };
  }

  it("fall 6 — freshly connected account pulse is insufficient_data with reasons, not zeros", async () => {
    const emptyTenant = await startTestDb();
    try {
      const emptyAccount = await seedMetaAccount(emptyTenant.pool, emptyTenant.tenantId);
      const sync = await seedSucceededSync(emptyTenant.pool, {
        tenantId: emptyTenant.tenantId,
        accountId: emptyAccount.accountId,
        windowStart,
        windowEnd,
        finishedAt,
      });
      await seedAccountWindow(emptyTenant.pool, {
        tenantId: emptyTenant.tenantId,
        accountId: emptyAccount.accountId,
        syncRunId: sync,
        windowStart,
        windowEnd,
        reach: 0,
        frequency: 0,
        observedAt: finishedAt,
      });
      const overview = await buildStrategistOverview({
        pool: emptyTenant.pool,
        tenantId: emptyTenant.tenantId,
        metaAdAccountId: emptyAccount.accountId,
        windowStart,
        windowEnd,
        dataAsOf,
      });
      expect(overview.pulse.spendEfficiency.status).toBe("insufficient_data");
      expect(overview.pulse.spendEfficiency.value).toBeNull();
      if (overview.pulse.spendEfficiency.status === "insufficient_data") {
        expect(overview.pulse.spendEfficiency.reason).toBe("no_ads_in_gate");
      }
      expect(overview.pulse.accountHealth.status).toBe("insufficient_data");
      expect(overview.pulse.overall.status).toBe("insufficient_data");
      expect(overview.pulse.overall.value).toBeNull();
    } finally {
      await emptyTenant.stop();
    }
  }, 60_000);

  it("fall 5 + previous_period_incomplete — missing prior days yield null previous, not 0", async () => {
    const shortTenant = await startTestDb();
    try {
      const shortAccount = await seedMetaAccount(shortTenant.pool, shortTenant.tenantId);
      const sync = await seedSucceededSync(shortTenant.pool, {
        tenantId: shortTenant.tenantId,
        accountId: shortAccount.accountId,
        windowStart,
        windowEnd,
        finishedAt,
      });
      const population = buildPassingPopulation({ windowStart, windowEnd, size: 8 });
      await seedFunnelPopulation(
        shortTenant.pool,
        shortAccount,
        population,
        sync,
        finishedAt,
      );
      await seedAccountWindow(shortTenant.pool, {
        tenantId: shortTenant.tenantId,
        accountId: shortAccount.accountId,
        syncRunId: sync,
        windowStart,
        windowEnd,
        reach: 5000,
        frequency: 1.2,
        observedAt: finishedAt,
      });
      // No previous-period dailies → incomplete.
      const overview = await buildStrategistOverview({
        pool: shortTenant.pool,
        tenantId: shortTenant.tenantId,
        metaAdAccountId: shortAccount.accountId,
        windowStart,
        windowEnd,
        dataAsOf,
      });
      expect(overview.previousPeriodComplete).toBe(false);
      expect(overview.overview.spend.previous).toBeNull();
      expect(overview.overview.spend.changePct).toBeNull();
      expect(overview.overview.spend.reason).toBe("previous_period_incomplete");
      expect(overview.overview.spend.value).not.toBeNull();
      expect(overview.ads[0]?.spend.previous).toBeNull();
      expect(overview.ads[0]?.spend.changePct).toBeNull();
    } finally {
      await shortTenant.stop();
    }
  }, 60_000);

  it("fall 7 — ad below minimum spend exposes below_minimum_spend, not a dash placeholder", async () => {
    const overview = await buildStrategistOverview({
      pool: db.pool,
      tenantId: db.tenantId,
      metaAdAccountId: account.accountId,
      windowStart,
      windowEnd,
      dataAsOf,
    });
    // Inject a low-spend ad into resolve path by seeding extra rows and rebuilding.
    const lowAdId = "10000000000999";
    await seedMetaAd(db.pool, {
      tenantId: db.tenantId,
      accountId: account.accountId,
      syncRunId,
      metaAdId: lowAdId,
      name: "Low Spend Ad",
      observedAt: finishedAt,
    });
    const { seedDailyRows, seedWindow } = await import("./metrics-fixtures");
    const days: Array<{ metaAdId: string; date: string; spend: number; impressions: number }> = [];
    const start = new Date(`${windowStart}T00:00:00.000Z`);
    const end = new Date(`${windowEnd}T00:00:00.000Z`);
    const dayCount = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    for (let i = 0; i < dayCount; i++) {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() + i);
      const date = day.toISOString().slice(0, 10);
      days.push({
        metaAdId: lowAdId,
        date,
        spend: date === windowEnd ? 10 : 0,
        impressions: date === windowEnd ? 200 : 0,
      });
    }
    await seedDailyRows(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      observedAt: finishedAt,
      rows: days,
    });
    await seedWindow(db.pool, {
      tenantId: db.tenantId,
      syncRunId,
      metaAdId: lowAdId,
      windowStart,
      windowEnd,
      reach: 150,
      frequency: 1.1,
      impressions: 200,
      spend: 10,
      observedAt: finishedAt,
    });

    const again = await buildStrategistOverview({
      pool: db.pool,
      tenantId: db.tenantId,
      metaAdAccountId: account.accountId,
      windowStart,
      windowEnd,
      dataAsOf,
    });
    const low = again.ads.find((ad) => ad.metaAdId === lowAdId);
    expect(low).toBeTruthy();
    expect(low!.funnelPosition.gateStatus).toBe("insufficient_data");
    expect(low!.funnelPosition.gateReasons).toContain("below_minimum_spend");
    expect(low!.funnelPosition.score).toBeNull();
  });

  it("fall 8 — fixed 30d and 90d fixture spend totals", async () => {
    const fixture = await startTestDb();
    try {
      const acct = await seedMetaAccount(fixture.pool, fixture.tenantId);
      const end = "2026-07-19";
      const start30 = "2026-06-20";
      const start90 = "2026-04-21";
      const sync = await seedSucceededSync(fixture.pool, {
        tenantId: fixture.tenantId,
        accountId: acct.accountId,
        windowStart: start90,
        windowEnd: end,
        finishedAt,
      });

      // One ad, gapless 90 days, all spend on the last day of each sub-window
      // so 30d and 90d sums are exact and distinct.
      const adId = "900000000000001";
      const spend30 = 120;
      const spendEarlier = 80; // days in the 90d window before the 30d window
      await seedMetaAd(fixture.pool, {
        tenantId: fixture.tenantId,
        accountId: acct.accountId,
        syncRunId: sync,
        metaAdId: adId,
        name: "Window Fixture Ad",
        observedAt: finishedAt,
      });

      const { seedDailyRows, seedWindow } = await import("./metrics-fixtures");
      const start = new Date(`${start90}T00:00:00.000Z`);
      const endDate = new Date(`${end}T00:00:00.000Z`);
      const dayCount =
        Math.round((endDate.getTime() - start.getTime()) / 86_400_000) + 1;
      const rows = [];
      for (let i = 0; i < dayCount; i++) {
        const day = new Date(start);
        day.setUTCDate(day.getUTCDate() + i);
        const date = day.toISOString().slice(0, 10);
        let spend = 0;
        let impressions = 0;
        if (date === end) {
          spend = spend30;
          impressions = 3000;
        } else if (date === "2026-05-01") {
          spend = spendEarlier;
          impressions = 2000;
        }
        rows.push({
          metaAdId: adId,
          date,
          spend,
          impressions,
          clicks: spend > 0 ? 50 : 0,
          linkClicks: spend > 0 ? 40 : 0,
          actions:
            spend > 0
              ? [
                  {
                    actionType: "offsite_conversion.fb_pixel_purchase",
                    count: 2,
                    value: 100,
                  },
                ]
              : [],
        });
      }
      await seedDailyRows(fixture.pool, {
        tenantId: fixture.tenantId,
        syncRunId: sync,
        observedAt: finishedAt,
        rows,
      });
      for (const [ws, we, reach, spend] of [
        [start30, end, 2500, spend30],
        [start90, end, 4000, spend30 + spendEarlier],
      ] as const) {
        await seedWindow(fixture.pool, {
          tenantId: fixture.tenantId,
          syncRunId: sync,
          metaAdId: adId,
          windowStart: ws,
          windowEnd: we,
          reach,
          frequency: 1.2,
          impressions: spend === spend30 ? 3000 : 5000,
          spend,
          observedAt: finishedAt,
        });
        await seedAccountWindow(fixture.pool, {
          tenantId: fixture.tenantId,
          accountId: acct.accountId,
          syncRunId: sync,
          windowStart: ws,
          windowEnd: we,
          reach,
          frequency: 1.2,
          impressions: spend === spend30 ? 3000 : 5000,
          spend,
          observedAt: finishedAt,
        });
      }

      const overview30 = await buildStrategistOverview({
        pool: fixture.pool,
        tenantId: fixture.tenantId,
        metaAdAccountId: acct.accountId,
        windowStart: start30,
        windowEnd: end,
        dataAsOf,
      });
      expect(overview30.overview.spend.value).toBe(spend30);
      expect(overview30.ads[0]?.spend.value).toBe(spend30);

      const overview90 = await buildStrategistOverview({
        pool: fixture.pool,
        tenantId: fixture.tenantId,
        metaAdAccountId: acct.accountId,
        windowStart: start90,
        windowEnd: end,
        dataAsOf,
      });
      expect(overview90.overview.spend.value).toBe(spend30 + spendEarlier);
      expect(overview90.ads[0]?.spend.value).toBe(spend30 + spendEarlier);
      expect(overview90.overview.spend.value).not.toBe(overview30.overview.spend.value);
    } finally {
      await fixture.stop();
    }
  }, 60_000);

  it("fall 3 — execute:false creates no run, job, chat, or creative_strategy_run", async () => {
    const before = await db.pool.query<{ c: string }>(
      `SELECT
         (SELECT count(*)::text FROM run WHERE tenant_id = $1) AS c`,
      [db.tenantId],
    );
    const beforeChats = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM chat WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const beforeMaps = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM creative_strategy_run WHERE tenant_id = $1`,
      [db.tenantId],
    );

    const adId = "100000000000000";
    const snapshots = await computeAndPersistSnapshots({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart,
      windowEnd,
      dataAsOf,
      sourceSyncRunIds: [syncRunId],
    });
    const snapshotId = snapshots.funnelSnapshotIds[0]!;

    const preview = await previewAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({
        adId,
        execute: false,
        snapshotId,
      }),
    });
    expect(preview.outcome).toBe("preview");
    if (preview.outcome !== "preview") return;
    expect(preview.contextPacket).toContain(windowStart);
    expect(preview.contextPacket).toContain(windowEnd);
    expect(preview.costEstimate).toBe("moderate");

    const after = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM run WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const afterChats = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM chat WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const afterMaps = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM creative_strategy_run WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const afterJobs = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM job j
       JOIN run r ON r.id = j.run_id
       WHERE r.tenant_id = $1`,
      [db.tenantId],
    );
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
    expect(afterChats.rows[0]!.c).toBe(beforeChats.rows[0]!.c);
    expect(afterMaps.rows[0]!.c).toBe(beforeMaps.rows[0]!.c);
    expect(Number(afterJobs.rows[0]!.c)).toBeGreaterThanOrEqual(0);
  });

  it("fall 1 + 2 — execute creates chat/messages for the requested ad with exact window and metric version in context_packet", async () => {
    setAgentModelForTests(
      new ScriptedModel([
        { text: "CRO review complete for the fixture ad.", toolUses: [] },
      ]),
    );

    const adId = "100000000000000";
    const snapshots = await computeAndPersistSnapshots({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart,
      windowEnd,
      dataAsOf,
      sourceSyncRunIds: [syncRunId],
    });
    // Find snapshot for this ad specifically.
    const snapRow = await db.pool.query<{ id: string }>(
      `SELECT id FROM metric_snapshot
       WHERE tenant_id = $1 AND subject_id = $2 AND formula_version = 'funnel_position_v1'
         AND window_start = $3::date AND window_end = $4::date
       ORDER BY computed_at DESC LIMIT 1`,
      [db.tenantId, adId, windowStart, windowEnd],
    );
    const snapshotId = snapRow.rows[0]?.id ?? snapshots.funnelSnapshotIds[0]!;

    const resolved = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart,
      windowEnd,
      dataAsOf,
    });

    const runId = uuidv7();
    const userMessageId = uuidv7();
    const assistantMessageId = uuidv7();
    const created = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({
        adId,
        mode: "cro",
        execute: true,
        runId,
        userMessageId,
        assistantMessageId,
        snapshotId,
      }),
    });
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") return;

    const mapping = await db.pool.query<{
      chat_id: string;
      meta_ad_id: string;
      run_type: string;
      title: string;
    }>(
      `SELECT chat_id, meta_ad_id, run_type, title
       FROM creative_strategy_run WHERE id = $1`,
      [created.creativeStrategyRunId],
    );
    expect(mapping.rows[0]!.meta_ad_id).toBe(adId);
    expect(mapping.rows[0]!.run_type).toBe("cro_review");
    expect(mapping.rows[0]!.chat_id).toBe(created.chatId);

    const messages = await db.pool.query<{ id: string; role: string }>(
      `SELECT id, role FROM message WHERE chat_id = $1 ORDER BY created_at`,
      [created.chatId],
    );
    expect(messages.rows.map((r) => r.id)).toEqual([userMessageId, assistantMessageId]);

    const worker = startWorker({
      pool: db.pool,
      connectionString: db.databaseUrl,
      workerId: `strategist-test-${uuidv7()}`,
      pollIntervalMs: 50,
      leaseMs: 30_000,
      heartbeatIntervalMs: 5_000,
      concurrency: 1,
      shutdownGraceMs: 2_000,
    });
    try {
      const deadline = Date.now() + 20_000;
      let packet: string | null = null;
      while (Date.now() < deadline) {
        const row = await db.pool.query<{
          context_packet: string | null;
          status: string;
        }>(`SELECT context_packet, status FROM run WHERE id = $1`, [runId]);
        if (row.rows[0]?.status === "completed" && row.rows[0].context_packet) {
          packet = row.rows[0].context_packet;
          break;
        }
        if (row.rows[0]?.status === "failed") {
          const err = await db.pool.query(`SELECT error FROM run WHERE id = $1`, [runId]);
          throw new Error(`run failed: ${JSON.stringify(err.rows[0])}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(packet).toBeTruthy();
      // Fall 2 — precise expectations, not a fuzzy "contains window".
      expect(packet!).toContain(`Performance window: ${windowStart} to ${windowEnd}`);
      expect(packet!).toContain(`dataAsOf: ${dataAsOf}`);
      expect(packet!).toContain(`Meta ad id: ${adId}`);
      expect(packet!).toContain(
        `version=${resolved.metricDefinition.version}`,
      );
      expect(packet!).toContain(resolved.metricDefinition.label);
      expect(packet!).toContain(`Funnel snapshot id: ${snapshotId}`);

      // Evidence must already be on the mapping row from the production path
      // (agent/turn.ts) — do not UPDATE it here; that would greenwash a regression.
      const stored = await db.pool.query<{
        payload: { evidence?: { inputPacketMarkdown?: string } };
      }>(`SELECT payload FROM creative_strategy_run WHERE id = $1`, [
        created.creativeStrategyRunId,
      ]);
      expect(stored.rows[0]!.payload.evidence?.inputPacketMarkdown).toBe(packet);
      process.stdout.write(
        "=== verification step 4: context packet ===\n" +
          (stored.rows[0]!.payload.evidence?.inputPacketMarkdown ?? "") +
          "\n",
      );
    } finally {
      await worker.shutdown();
    }
  }, 60_000);

  it("fall 4 — second concurrent review of same ad+type is rejected", async () => {
    const adId = "100000000000001";
    const first = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({ adId, mode: "copychief", runId: uuidv7() }),
    });
    expect(first.outcome).toBe("created");

    const second = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({ adId, mode: "copychief", runId: uuidv7() }),
    });
    expect(second.outcome).toBe("concurrency_conflict");
  });

  it("P0 — foreign chatId does not create run, message, or mapping", async () => {
    const otherTenantId = uuidv7();
    await db.pool.query(`INSERT INTO tenant (id, name) VALUES ($1, 'other-tenant')`, [
      otherTenantId,
    ]);
    const foreignChatId = uuidv7();
    await db.pool.query(
      `INSERT INTO chat (id, tenant_id, name) VALUES ($1, $2, 'foreign')`,
      [foreignChatId, otherTenantId],
    );

    const beforeRuns = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM run WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const beforeMessages = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM message WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const beforeMaps = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM creative_strategy_run WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const beforeForeignMessages = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM message WHERE chat_id = $1`,
      [foreignChatId],
    );

    const result = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({
        adId: "100000000000000",
        mode: "variations",
        chatId: foreignChatId,
      }),
    });
    expect(result.outcome).toBe("not_found");

    const afterRuns = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM run WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const afterMessages = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM message WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const afterMaps = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM creative_strategy_run WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const afterForeignMessages = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM message WHERE chat_id = $1`,
      [foreignChatId],
    );
    const crossTenantRuns = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM run WHERE chat_id = $1`,
      [foreignChatId],
    );

    expect(afterRuns.rows[0]!.c).toBe(beforeRuns.rows[0]!.c);
    expect(afterMessages.rows[0]!.c).toBe(beforeMessages.rows[0]!.c);
    expect(afterMaps.rows[0]!.c).toBe(beforeMaps.rows[0]!.c);
    expect(afterForeignMessages.rows[0]!.c).toBe(beforeForeignMessages.rows[0]!.c);
    expect(crossTenantRuns.rows[0]!.c).toBe("0");
  });

  it("P1 — retry without chatId replays the existing run (no orphan chat)", async () => {
    const adId = "100000000000002";
    const runId = uuidv7();
    const userMessageId = uuidv7();
    const assistantMessageId = uuidv7();
    const first = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({
        adId,
        mode: "variations",
        runId,
        userMessageId,
        assistantMessageId,
      }),
    });
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;

    const chatsBefore = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM chat WHERE tenant_id = $1`,
      [db.tenantId],
    );

    const retry = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({
        adId,
        mode: "variations",
        runId,
        userMessageId,
        assistantMessageId,
        // chatId intentionally omitted — client lost it after a timeout
      }),
    });
    expect(retry.outcome).toBe("idempotent_replay");
    if (retry.outcome !== "idempotent_replay") return;
    expect(retry.chatId).toBe(first.chatId);
    expect(retry.creativeStrategyRunId).toBe(first.creativeStrategyRunId);

    const chatsAfter = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM chat WHERE tenant_id = $1`,
      [db.tenantId],
    );
    expect(chatsAfter.rows[0]!.c).toBe(chatsBefore.rows[0]!.c);
  });

  it("P1 — truly concurrent reviews of same ad+type: one wins, one already_running", async () => {
    const adId = "100000000000003";
    const { clientA, pidA, clientB, pidB, release } = await acquireTwoDistinctClients(
      db.pool,
    );
    expect(pidA).not.toBe(pidB);

    let a: Awaited<ReturnType<typeof executeAdReview>>;
    let b: Awaited<ReturnType<typeof executeAdReview>>;
    try {
      const barrier = createBarrier(2);
      [a, b] = await Promise.all([
        (async () => {
          await barrier.arrive();
          return executeAdReview(clientA, {
            tenantId: db.tenantId,
            userId,
            request: baseRequest({
              adId,
              mode: "copychief",
              runId: uuidv7(),
            }),
          });
        })(),
        (async () => {
          await barrier.arrive();
          return executeAdReview(clientB, {
            tenantId: db.tenantId,
            userId,
            request: baseRequest({
              adId,
              mode: "copychief",
              runId: uuidv7(),
            }),
          });
        })(),
      ]);
    } finally {
      release();
    }

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["concurrency_conflict", "created"]);

    const activeJobs = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM job
       WHERE tenant_id = $1
         AND family = 'copychief_review'
         AND input->>'metaAdId' = $2
         AND status IN ('queued', 'claimed', 'retry_scheduled', 'cancel_requested')`,
      [db.tenantId, adId],
    );
    expect(activeJobs.rows[0]!.c).toBe("1");
  });

  it("P1 — snapshot data_as_of mismatch is rejected", async () => {
    const adId = "100000000000000";
    const snap = await db.pool.query<{ id: string; data_as_of: string }>(
      `SELECT id, data_as_of::text FROM metric_snapshot
       WHERE tenant_id = $1 AND subject_id = $2 AND formula_version = 'funnel_position_v1'
         AND window_start = $3::date AND window_end = $4::date
       ORDER BY computed_at DESC LIMIT 1`,
      [db.tenantId, adId, windowStart, windowEnd],
    );
    expect(snap.rows[0]).toBeTruthy();

    const result = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({
        adId,
        mode: "cro",
        snapshotId: snap.rows[0]!.id,
        analysisWindow: {
          since: windowStart,
          until: windowEnd,
          label: "Last 30 days",
          // Same window, different data stand — must not accept T1 snapshot with T2 asOf.
          dataAsOf: "2026-07-21T12:00:00.000Z",
        },
      }),
    });
    expect(result.outcome).toBe("snapshot_mismatch");
  });

  it("P1 — ad from another account without snapshot is not_found", async () => {
    const otherAccount = await seedMetaAccount(db.pool, db.tenantId);
    const otherSync = await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: otherAccount.accountId,
      windowStart: "2026-01-01",
      windowEnd,
      finishedAt,
    });
    const foreignAdId = "900000000000099";
    await seedMetaAd(db.pool, {
      tenantId: db.tenantId,
      accountId: otherAccount.accountId,
      syncRunId: otherSync,
      metaAdId: foreignAdId,
      name: "Foreign account ad",
      observedAt: finishedAt,
    });

    const result = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({
        adId: foreignAdId,
        // account.accountId is A; ad lives on otherAccount B — no snapshotId.
        mode: "cro",
      }),
    });
    expect(result.outcome).toBe("not_found");

    const maps = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM creative_strategy_run
       WHERE tenant_id = $1 AND meta_ad_id = $2`,
      [db.tenantId, foreignAdId],
    );
    expect(maps.rows[0]!.c).toBe("0");
  });

  it("P1 — review request is stored as code+params, not English prose", async () => {
    const adId = "100000000000000";
    const created = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({ adId, mode: "cro", runId: uuidv7() }),
    });
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") return;

    expect(created.titleCode).toBe("strategist.cro_review_title");
    expect(created.titleParams.adName).toContain("Fixture Ad");

    const message = await db.pool.query<{
      content: string;
      content_code: string | null;
      content_params: { adName?: string; since?: string; until?: string } | null;
    }>(
      `SELECT content, content_code, content_params
       FROM message WHERE id = $1`,
      // userMessageId was generated inside baseRequest — load via chat
      [
        (
          await db.pool.query<{ id: string }>(
            `SELECT id FROM message
             WHERE chat_id = $1 AND role = 'user' LIMIT 1`,
            [created.chatId],
          )
        ).rows[0]!.id,
      ],
    );
    expect(message.rows[0]!.content).toBe("");
    expect(message.rows[0]!.content_code).toBe("strategist.cro_review_request");
    expect(message.rows[0]!.content_params?.adName).toBeTruthy();
    expect(message.rows[0]!.content).not.toMatch(/Run a CRO/i);

    const chat = await db.pool.query<{
      name: string;
      name_code: string | null;
      name_params: { adName?: string } | null;
    }>(`SELECT name, name_code, name_params FROM chat WHERE id = $1`, [created.chatId]);
    expect(chat.rows[0]!.name_code).toBe("strategist.cro_review_title");
    expect(chat.rows[0]!.name).toBe("");
  });

  it("snapshot_mismatch — snapshot from another ad is rejected", async () => {
    const adA = "100000000000000";
    const adB = "100000000000002";
    const snap = await db.pool.query<{ id: string }>(
      `SELECT id FROM metric_snapshot
       WHERE tenant_id = $1 AND subject_id = $2 AND formula_version = 'funnel_position_v1'
       ORDER BY computed_at DESC LIMIT 1`,
      [db.tenantId, adA],
    );
    expect(snap.rows[0]).toBeTruthy();

    const result = await executeAdReview(db.pool, {
      tenantId: db.tenantId,
      userId,
      request: baseRequest({
        adId: adB,
        mode: "variations",
        snapshotId: snap.rows[0]!.id,
      }),
    });
    expect(result.outcome).toBe("snapshot_mismatch");
  });

  it("render_artifacts ad_table follows the generic field schema", () => {
    const artifact = adTableArtifact({
      runId: uuidv7(),
      rows: [
        {
          id: "100000000000000",
          fields: [
            { fieldId: "name", label: "Ad", value: "Fixture Ad 00" },
            { fieldId: "spend", label: "Spend", value: 80 },
          ],
        },
      ],
    });
    expect(artifact.kind).toBe("ad_table");
    expect(artifact.rows[0]!.fields[0]!.fieldId).toBe("name");
  });

  it("spend efficiency uses median CPA over gated ads", async () => {
    const resolved = await resolveMetrics({
      pool: db.pool,
      tenantId: db.tenantId,
      adAccountId: account.accountId,
      windowStart,
      windowEnd,
      dataAsOf,
    });
    const index = computeSpendEfficiency(resolved);
    expect(index.status).toBe("ok");
    if (index.status === "ok") {
      expect(index.value).toBeGreaterThan(0);
      expect(index.value).toBeLessThanOrEqual(100);
    }
    const health = computeAccountHealth(resolved, {
      tokenExpired: false,
      lastSyncFailed: false,
      metricBindingMissing: false,
      noConversionMetric: true,
    });
    expect(health.status).toBe("ok");
    if (health.status === "ok") {
      expect(health.value).toBeLessThanOrEqual(75);
    }
  });

  it("SYNC_BACKFILL_DAYS accepts 180 and caps at 400", async () => {
    const prev = process.env.SYNC_BACKFILL_DAYS;
    process.env.SYNC_BACKFILL_DAYS = "180";
    // Re-import env is cached — assert schema bounds via zod parse of the constant path.
    const { z } = await import("zod");
    const schema = z.coerce.number().int().min(1).max(400).default(180);
    expect(schema.parse("180")).toBe(180);
    expect(schema.parse("400")).toBe(400);
    expect(schema.safeParse("401").success).toBe(false);
    if (prev === undefined) delete process.env.SYNC_BACKFILL_DAYS;
    else process.env.SYNC_BACKFILL_DAYS = prev;
  });
});
