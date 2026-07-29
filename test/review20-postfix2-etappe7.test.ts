/**
 * Review 20 / post-fix 2 — last Etappe 7 round before acceptance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";
import { setPoolForTests } from "@/db/pool";
import {
  type TestDb,
  startTestDb,
  sleep,
  insertQueuedRun,
} from "./db-harness";
import {
  MemoryObjectStore,
  setObjectStoreForTests,
} from "@/storage/object-store";
import { seedMetaAccount } from "./metrics-fixtures";
import {
  loadActiveBinding,
  saveDefaults,
  resolvePublishPayload,
} from "@/publish/resolve";
import {
  createPublication,
  runPublication,
} from "@/publish/chain";
import { MockMetaWriteClient } from "@/publish/mock-client";
import { PublishHumanInputSchema } from "@/publish/schemas";
import {
  AdvertiserDefaultsSchema,
  BindingAttributionSpecSchema,
} from "@/publish/settings";
import { mergeDefaultsFormPatch } from "@/publish/defaults-form";
import { setWriteClientForTests } from "@/publish/client-factory";
import { clearRegistry, registerFamily } from "@/queue/registry";
import { metaPublishFamily } from "@/queue/families/meta-publish";
import { startWorker } from "@/queue/poll-loop";
import {
  SESSION_COOKIE,
  createSession,
  encodeSession,
} from "@/auth/session";
import {
  GET as getSettings,
  PUT as putSettings,
} from "@/app/api/meta/ad-account-settings/route";
import { GET as getBindings } from "@/app/api/meta/metric-bindings/route";

const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe("review 20 — postfix2 etappe 7", () => {
  let db: TestDb;
  let store: MemoryObjectStore;
  let mock: MockMetaWriteClient;
  let advertiserId: string;
  let accountId: string;
  let creativeId: string;
  let userId: string;
  let metricId: string;
  let bindingId: string;

  beforeAll(async () => {
    clearRegistry();
    registerFamily(metaPublishFamily);
    db = await startTestDb();
    setPoolForTests(db.pool);
  }, 60_000);

  afterAll(async () => {
    setWriteClientForTests(null);
    setObjectStoreForTests(null);
    setPoolForTests(null);
    clearRegistry();
    await db.stop();
  });

  beforeEach(async () => {
    store = new MemoryObjectStore();
    setObjectStoreForTests(store);
    mock = new MockMetaWriteClient();
    setWriteClientForTests(mock);

    await db.pool.query(`DELETE FROM publication_step`);
    await db.pool.query(`DELETE FROM publication`);
    await db.pool.query(`DELETE FROM metric_optimization_binding`);
    await db.pool.query(`DELETE FROM ad_account_metric_assignment`);
    await db.pool.query(`DELETE FROM conversion_metric`);
    await db.pool.query(`DELETE FROM advertiser_defaults`);
    await db.pool.query(`DELETE FROM creative`);
    await db.pool.query(`DELETE FROM asset`);
    await db.pool.query(`DELETE FROM meta_ad_account`);
    await db.pool.query(`DELETE FROM meta_connection`);
    await db.pool.query(`DELETE FROM advertiser WHERE tenant_id = $1`, [
      db.tenantId,
    ]);
    await db.pool.query(`DELETE FROM job_dead_letter`);
    await db.pool.query(`DELETE FROM job WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM run WHERE tenant_id = $1`, [db.tenantId]);

    const seeded = await seedMetaAccount(db.pool, db.tenantId);
    advertiserId = seeded.advertiserId;
    accountId = seeded.accountId;
    userId = uuidv7();
    await db.pool.query(
      `UPDATE meta_ad_account SET meta_ad_account_id = 'act_861604393480918' WHERE id = $1`,
      [accountId],
    );

    await saveDefaults(db.pool, {
      tenantId: db.tenantId,
      advertiserId,
      settings: AdvertiserDefaultsSchema.parse({
        identity: {
          pageId: "page_test",
          beneficiaryName: "Test GmbH",
          payerName: "Test GmbH",
        },
        adSet: {
          optimizationGoal: "LINK_CLICKS",
          targeting: { countries: ["DE"] },
          budgetMode: "ABO",
        },
        website: { url: "https://example.com", utmParams: "" },
        autoNaming: {
          creativeTemplate: "{advertiser}",
          adSetTemplate: "{advertiser}",
          adTemplate: "{creative}",
        },
      }),
      createdBy: userId,
    });

    metricId = uuidv7();
    await db.pool.query(
      `INSERT INTO conversion_metric (
         id, tenant_id, label, version,
         numerator_action_types, numerator_aggregation, attribution_spec,
         denominator, value_source, effective_from
       ) VALUES (
         $1, $2, 'Lead', 1,
         ARRAY['lead'], 'sum_disjoint', ARRAY['1d_view','7d_click'],
         NULL, 'none', now() - interval '1 day'
       )`,
      [metricId, db.tenantId],
    );
    await db.pool.query(
      `INSERT INTO ad_account_metric_assignment (
         id, tenant_id, meta_ad_account_id, conversion_metric_id, effective_from
       ) VALUES ($1, $2, $3, $4, now() - interval '1 day')`,
      [uuidv7(), db.tenantId, accountId, metricId],
    );
    bindingId = uuidv7();
    await db.pool.query(
      `INSERT INTO metric_optimization_binding (
         id, tenant_id, conversion_metric_id, conversion_metric_version,
         optimization_goal, promoted_object, attribution_spec,
         version, active
       ) VALUES (
         $1, $2, $3, 1,
         'LINK_CLICKS', $4::jsonb, ARRAY['1d_view','7d_click'],
         1, true
       )`,
      [bindingId, db.tenantId, metricId, JSON.stringify({ page_id: "page_test" })],
    );

    const assetId = uuidv7();
    const storageKey = `creatives/${assetId}.png`;
    await store.putBytes(storageKey, PNG_1X1, "image/png");
    await db.pool.query(
      `INSERT INTO asset (
         id, tenant_id, kind, storage_key, width, height, mime, checksum
       ) VALUES ($1, $2, 'image', $3, 1, 1, 'image/png', 'abc')`,
      [assetId, db.tenantId, storageKey],
    );
    creativeId = uuidv7();
    await db.pool.query(
      `INSERT INTO creative (
         id, tenant_id, advertiser_id, name, primary_text, headline,
         description, call_to_action, asset_id, aspect_ratio, status
       ) VALUES (
         $1, $2, $3, 'Hero', 'Buy now', 'Headline',
         'Desc', 'LEARN_MORE', $4, '1:1', 'ready'
       )`,
      [creativeId, db.tenantId, advertiserId, assetId],
    );
  });

  async function createPendingPublication() {
    const human = PublishHumanInputSchema.parse({
      advertiserId,
      metaAdAccountId: accountId,
      creativeIds: [creativeId],
      campaign: { mode: "new", budgetMode: "ABO" },
      adSet: { mode: "new" },
      idempotencyKey: uuidv7(),
      budget: { amount: 1000, currency: "EUR" },
    });
    const resolved = await resolvePublishPayload(db.pool, {
      tenantId: db.tenantId,
      userId,
      input: human,
      allowHumanBudget: true,
    });
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input, created_at, updated_at)
       VALUES ($1, $2, 'publish_request', 'queued', '{}'::jsonb, now(), now())`,
      [runId, db.tenantId],
    );
    const { publicationId } = await createPublication(db.pool, {
      tenantId: db.tenantId,
      runId,
      payload: resolved,
    });
    return { publicationId, resolved };
  }

  async function markStepPendingReconcile(
    publicationId: string,
    operation: string,
    extras: {
      priorSucceeded?: Array<{
        operation: string;
        externalId: string;
      }>;
    } = {},
  ) {
    for (const prior of extras.priorSucceeded ?? []) {
      await db.pool.query(
        `UPDATE publication_step
         SET status = 'succeeded', external_id = $3, reconcile_state = 'resolved'
         WHERE publication_id = $1 AND operation = $2`,
        [publicationId, prior.operation, prior.externalId],
      );
    }
    const step = await db.pool.query<{
      id: string;
      object_name: string;
      external_correlation: string;
      step_index: number;
    }>(
      `SELECT id, object_name, external_correlation, step_index
       FROM publication_step
       WHERE publication_id = $1 AND operation = $2`,
      [publicationId, operation],
    );
    const row = step.rows[0]!;
    const dispatchedAt = new Date(Date.now() - 30_000).toISOString();
    await db.pool.query(
      `UPDATE publication_step
       SET status = 'in_flight',
           attempt = 1,
           dispatched_at = $2::timestamptz,
           reconcile_state = 'pending',
           lease_expires_at = now() - interval '1 minute'
       WHERE id = $1`,
      [row.id, dispatchedAt],
    );
    await db.pool.query(
      `UPDATE publication SET status = 'failed' WHERE id = $1`,
      [publicationId],
    );
    return { ...row, dispatchedAt };
  }

  it("R20-1 — ownership rejects foreign campaign, adset, creative, and ad", async () => {
    const { publicationId, resolved } = await createPendingPublication();
    const accountExternal = resolved.metaAdAccountExternalId;
    const pageId = resolved.creatives[0]!.pageId;

    // Campaign — wrong objective inside window
    {
      const step = await markStepPendingReconcile(publicationId, "create_campaign");
      mock.seed("camp_foreign", "campaign", step.object_name, "PAUSED", {
        objective: "OUTCOME_SALES",
        createdTime: new Date(Date.now() - 5_000).toISOString(),
      });
      const outcome = await runPublication(db.pool, {
        publicationId,
        tenantId: db.tenantId,
        client: mock,
        store,
      });
      expect(outcome.status).toBe("needs_human_review");
      const final = await db.pool.query<{ error: { reason?: string } | null }>(
        `SELECT error FROM publication_step WHERE id = $1`,
        [step.id],
      );
      expect(final.rows[0]?.error?.reason).toBe("objective_mismatch");
    }

    // Reset publication for next ops — fresh publication
    await db.pool.query(`DELETE FROM publication_step`);
    await db.pool.query(`DELETE FROM publication`);
    const second = await createPendingPublication();

    // Ad set — wrong campaign id
    {
      mock.seed("camp_ok", "campaign", "camp", "PAUSED", {
        objective: "OUTCOME_TRAFFIC",
      });
      const step = await markStepPendingReconcile(
        second.publicationId,
        "create_adset",
        { priorSucceeded: [{ operation: "create_campaign", externalId: "camp_ok" }] },
      );
      mock.seed("adset_foreign", "adset", step.object_name, "PAUSED", {
        optimizationGoal: "LINK_CLICKS",
        campaignId: "camp_OTHER",
        createdTime: new Date(Date.now() - 5_000).toISOString(),
      });
      const outcome = await runPublication(db.pool, {
        publicationId: second.publicationId,
        tenantId: db.tenantId,
        client: mock,
        store,
      });
      expect(outcome.status).toBe("needs_human_review");
      const final = await db.pool.query<{ error: { reason?: string } | null }>(
        `SELECT error FROM publication_step WHERE id = $1`,
        [step.id],
      );
      expect(final.rows[0]?.error?.reason).toBe("adset_campaign_mismatch");
    }

    await db.pool.query(`DELETE FROM publication_step`);
    await db.pool.query(`DELETE FROM publication`);
    const third = await createPendingPublication();

    // Creative — wrong page_id
    {
      const step = await markStepPendingReconcile(
        third.publicationId,
        "create_creative",
        {
          priorSucceeded: [
            { operation: "create_campaign", externalId: "camp_ok" },
            { operation: "create_adset", externalId: "adset_ok" },
          ],
        },
      );
      mock.seed("creative_foreign", "creative", step.object_name, "PAUSED", {
        accountId: accountExternal,
        pageId: "page_FOREIGN",
        createdTime: new Date(Date.now() - 5_000).toISOString(),
      });
      const outcome = await runPublication(db.pool, {
        publicationId: third.publicationId,
        tenantId: db.tenantId,
        client: mock,
        store,
      });
      expect(outcome.status).toBe("needs_human_review");
      const final = await db.pool.query<{ error: { reason?: string } | null }>(
        `SELECT error FROM publication_step WHERE id = $1`,
        [step.id],
      );
      expect(final.rows[0]?.error?.reason).toBe("creative_page_mismatch");
      expect(pageId).toBe("page_test");
    }

    await db.pool.query(`DELETE FROM publication_step`);
    await db.pool.query(`DELETE FROM publication`);
    const fourth = await createPendingPublication();

    // Ad — wrong creative / adset
    {
      const step = await markStepPendingReconcile(
        fourth.publicationId,
        "create_ad",
        {
          priorSucceeded: [
            { operation: "create_campaign", externalId: "camp_ok" },
            { operation: "create_adset", externalId: "adset_expected" },
            { operation: "create_creative", externalId: "creative_expected" },
          ],
        },
      );
      mock.seed("ad_foreign", "ad", step.object_name, "PAUSED", {
        adSetId: "adset_OTHER",
        creativeId: "creative_OTHER",
        createdTime: new Date(Date.now() - 5_000).toISOString(),
      });
      const outcome = await runPublication(db.pool, {
        publicationId: fourth.publicationId,
        tenantId: db.tenantId,
        client: mock,
        store,
      });
      expect(outcome.status).toBe("needs_human_review");
      const final = await db.pool.query<{ error: { reason?: string } | null }>(
        `SELECT error FROM publication_step WHERE id = $1`,
        [step.id],
      );
      expect(final.rows[0]?.error?.reason).toMatch(
        /ad_adset_mismatch|ad_creative_mismatch/,
      );
    }
  });

  it("R20-1 mutation proof — creative/ad ownership gates exist in source", () => {
    const src = readFileSync(
      join(process.cwd(), "src/publish/chain.ts"),
      "utf8",
    );
    expect(src).toContain("creative_page_mismatch");
    expect(src).toContain("creative_account_mismatch");
    expect(src).toContain("ad_adset_mismatch");
    expect(src).toContain("ad_creative_mismatch");
    expect(src).toContain("case \"create_creative\"");
    // Must not short-circuit creative/ad to ok:true without Meta reads.
    expect(src).toMatch(/case "create_creative":[\s\S]*getAdCreative/);
    expect(src).toMatch(/case "create_ad":[\s\S]*getAd\(/);
  });

  it("R20-2 — exhausted post_dispatch_uncertain → needs_human_review", async () => {
    const { publicationId, resolved } = await createPendingPublication();
    const step = await markStepPendingReconcile(publicationId, "create_campaign");
    void step;
    mock.searchAlwaysFails = true;

    const prevMax = metaPublishFamily.maxAttempts;
    metaPublishFamily.maxAttempts = 3;

    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "meta_publish",
      input: { resolved, publicationId },
    });

    const worker = startWorker({
      pool: db.pool,
      connectionString: db.databaseUrl,
      workerId: `worker-${uuidv7()}`,
      pollIntervalMs: 20,
      leaseMs: 30_000,
      heartbeatIntervalMs: 5_000,
      concurrency: 1,
      shutdownGraceMs: 2_000,
    });

    try {
      let status = "";
      for (let i = 0; i < 300 && status !== "completed" && status !== "failed"; i += 1) {
        await sleep(40);
        const { rows } = await db.pool.query<{ status: string }>(
          `SELECT status FROM job WHERE id = $1`,
          [jobId],
        );
        status = rows[0]?.status ?? "";
      }
      expect(status).toBe("completed");
    } finally {
      metaPublishFamily.maxAttempts = prevMax;
      await worker.shutdown();
    }

    const pub = await db.pool.query<{ status: string }>(
      `SELECT status FROM publication WHERE id = $1`,
      [publicationId],
    );
    expect(pub.rows[0]?.status).toBe("needs_human_review");

    const dead = await db.pool.query(
      `SELECT 1 FROM job_dead_letter WHERE job_id = $1`,
      [jobId],
    );
    expect(dead.rowCount).toBe(0);

    const job = await db.pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM job WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]?.attempts).toBe(3);
    expect(job.rows[0]?.status).toBe("completed");

    const run = await db.pool.query<{ result: { status?: string } | null }>(
      `SELECT result FROM run WHERE id = (SELECT run_id FROM job WHERE id = $1)`,
      [jobId],
    );
    expect(run.rows[0]?.result?.status).toBe("needs_human_review");
  }, 30_000);

  it("R20-2 mutation proof — attempts_exhausted path is in the handler", () => {
    const src = readFileSync(
      join(process.cwd(), "src/queue/families/meta-publish.ts"),
      "utf8",
    );
    expect(src).toContain("attempts_exhausted");
    expect(src).toContain("markPublicationNeedsHumanReview");
    expect(src).toContain("ctx.attempts >= ctx.maxAttempts");
  });

  it("R20-3 — route+form: version conflict and DSA clear via null", async () => {
    const cookie = `${SESSION_COOKIE}=${encodeSession(
      createSession(userId, db.tenantId),
    )}`;

    const getReq = new NextRequest(
      `http://localhost/api/meta/ad-account-settings?advertiserId=${advertiserId}`,
      { headers: { cookie } },
    );
    const getRes = await getSettings(getReq);
    expect(getRes.status).toBe(200);
    const loaded = (await getRes.json()) as {
      version: number;
      settings: ReturnType<typeof AdvertiserDefaultsSchema.parse>;
    };
    expect(loaded.version).toBe(1);
    expect(loaded.settings.identity.beneficiaryName).toBe("Test GmbH");

    // Window A: change website (same form merge path as settings/page.tsx)
    const formA = {
      pageId: "page_test",
      instagramActorId: "",
      beneficiaryName: "Test GmbH",
      payerName: "Test GmbH",
      optimizationGoal: "LINK_CLICKS",
      budgetMode: "ABO" as const,
      countries: "DE",
      websiteUrl: "https://a.example.com",
      utmParams: "",
      creativeTemplate: "{advertiser}",
      adSetTemplate: "{advertiser}",
      adTemplate: "{creative}",
    };
    const settingsA = mergeDefaultsFormPatch(loaded.settings, formA);
    const putA = await putSettings(
      new NextRequest("http://localhost/api/meta/ad-account-settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          advertiserId,
          expectedVersion: loaded.version,
          settings: settingsA,
        }),
      }),
    );
    expect(putA.status).toBe(200);
    const savedA = (await putA.json()) as { version: number };
    expect(savedA.version).toBe(2);

    // Window B: stale expectedVersion → conflict (lost update blocked)
    const formB = { ...formA, websiteUrl: "https://example.com", payerName: "New Pay" };
    const settingsB = mergeDefaultsFormPatch(loaded.settings, formB);
    const putB = await putSettings(
      new NextRequest("http://localhost/api/meta/ad-account-settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          advertiserId,
          expectedVersion: loaded.version,
          settings: settingsB,
        }),
      }),
    );
    expect(putB.status).toBe(409);
    const conflict = (await putB.json()) as { error: string };
    expect(conflict.error).toBe("settings_version_conflict");

    // Clear DSA via empty form fields → null → deleted
    const get2 = await getSettings(
      new NextRequest(
        `http://localhost/api/meta/ad-account-settings?advertiserId=${advertiserId}`,
        { headers: { cookie } },
      ),
    );
    const loaded2 = (await get2.json()) as {
      version: number;
      settings: ReturnType<typeof AdvertiserDefaultsSchema.parse>;
    };
    const clearForm = {
      ...formA,
      websiteUrl: loaded2.settings.website.url,
      beneficiaryName: "",
      payerName: "",
    };
    const cleared = mergeDefaultsFormPatch(loaded2.settings, clearForm);
    expect(cleared.identity.beneficiaryName).toBeNull();
    expect(cleared.identity.payerName).toBeNull();

    const putClear = await putSettings(
      new NextRequest("http://localhost/api/meta/ad-account-settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          advertiserId,
          expectedVersion: loaded2.version,
          settings: cleared,
        }),
      }),
    );
    expect(putClear.status).toBe(200);
    const afterClear = (await putClear.json()) as {
      settings: { identity: { beneficiaryName?: string; payerName?: string } };
    };
    expect(afterClear.settings.identity.beneficiaryName).toBeUndefined();
    expect(afterClear.settings.identity.payerName).toBeUndefined();
  });

  it("R20-4 — corrupt attribution fails before Meta campaign read", async () => {
    await db.pool.query(
      `UPDATE metric_optimization_binding
       SET attribution_spec = ARRAY['30d_click']
       WHERE id = $1`,
      [bindingId],
    );
    mock.seed("camp_cbo", "campaign", "CBO", "PAUSED", { dailyBudget: 5000 });

    let readerCalls = 0;
    await expect(
      resolvePublishPayload(db.pool, {
        tenantId: db.tenantId,
        userId,
        input: PublishHumanInputSchema.parse({
          advertiserId,
          metaAdAccountId: accountId,
          creativeIds: [creativeId],
          campaign: { mode: "existing", existingCampaignId: "camp_cbo" },
          adSet: { mode: "new" },
          idempotencyKey: uuidv7(),
          deviationReason: "legacy_binding",
        }),
        allowHumanBudget: true,
        campaignReader: {
          getCampaign: async (id) => {
            readerCalls += 1;
            return mock.getCampaign(id);
          },
        },
      }),
    ).rejects.toMatchObject({ code: "binding_data_corrupt", params: { bindingId } });
    expect(readerCalls).toBe(0);
  });

  it("R20-5 — GET binding and loadActiveBinding reject corrupt Bestandsdaten", async () => {
    await db.pool.query(
      `UPDATE metric_optimization_binding
       SET attribution_spec = ARRAY['30d_click']
       WHERE id = $1`,
      [bindingId],
    );

    await expect(
      loadActiveBinding(db.pool, db.tenantId, metricId),
    ).rejects.toMatchObject({ code: "binding_data_corrupt" });

    const cookie = `${SESSION_COOKIE}=${encodeSession(
      createSession(userId, db.tenantId),
    )}`;
    const res = await getBindings(
      new NextRequest(
        `http://localhost/api/meta/metric-bindings?conversionMetricId=${metricId}`,
        { headers: { cookie } },
      ),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      params?: { bindingId?: string };
    };
    expect(body.error).toBe("binding_data_corrupt");
    expect(body.params?.bindingId).toBe(bindingId);

    // Schema still rejects at write time
    expect(
      BindingAttributionSpecSchema.safeParse(["30d_click"]).success,
    ).toBe(false);
  });
});
