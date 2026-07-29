import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";
import { setPoolForTests } from "@/db/pool";
import { type TestDb, startTestDb } from "./db-harness";
import {
  MemoryObjectStore,
  setObjectStoreForTests,
} from "@/storage/object-store";
import { seedMetaAccount } from "./metrics-fixtures";
import { saveDefaults } from "@/publish/resolve";
import { resolvePublishPayload } from "@/publish/resolve";
import {
  createPublication,
  runPublication,
} from "@/publish/chain";
import { MockMetaWriteClient } from "@/publish/mock-client";
import {
  setCrashAfterPersistForTests,
  setPublishClockForTests,
} from "@/publish/fault";
import {
  META_PUBLISH_STATUS,
  PublishAgentInputSchema,
  PublishError,
  PublishHumanInputSchema,
} from "@/publish/schemas";
import { applyUtmParams } from "@/publish/utm";
import { resolveBudgetPlacement, requireBudgetSource } from "@/publish/budget";
import type { AdvertiserDefaults } from "@/publish/settings";
import {
  AdvertiserDefaultsSchema,
  BindingAttributionSpecSchema,
} from "@/publish/settings";
import { mergeDefaultsFormPatch } from "@/publish/defaults-form";

const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

function defaultSettings(pageId = "page_test"): AdvertiserDefaults {
  return AdvertiserDefaultsSchema.parse({
    identity: {
      pageId,
      beneficiaryName: "Test GmbH",
      payerName: "Test GmbH",
    },
    adSet: {
      optimizationGoal: "LINK_CLICKS",
      targeting: { countries: ["DE"] },
      budgetMode: "ABO",
      schedule: { timezone: "Europe/Berlin", offsetDays: 1, time: "09:00" },
      attribution: { click: "7d_click", view: "1d_view", engaged: "none" },
    },
    website: {
      url: "https://example.com/land",
      utmParams: "utm_source=meta&utm_campaign={{campaign.name}}",
    },
    autoNaming: {
      creativeTemplate: "{advertiser} / {creative}",
      adSetTemplate: "{advertiser} / {optimization}",
      adTemplate: "{creative} / ad",
    },
    campaignObjective: "OUTCOME_TRAFFIC",
  });
}

describe("etappe 7 — launch", () => {
  let db: TestDb;
  let store: MemoryObjectStore;
  let mock: MockMetaWriteClient;
  let advertiserId: string;
  let accountId: string;
  let creativeId: string;
  let userId: string;
  let metricId: string;

  async function seedFixture(options?: {
    optimizationGoal?: AdvertiserDefaults["adSet"]["optimizationGoal"];
    bindingGoal?: string;
    bindingAttribution?: string[];
    defaultsAttribution?: AdvertiserDefaults["adSet"]["attribution"];
    countries?: string[];
    omitDsa?: boolean;
  }) {
    const seeded = await seedMetaAccount(db.pool, db.tenantId);
    advertiserId = seeded.advertiserId;
    accountId = seeded.accountId;
    userId = uuidv7();

    const settings = defaultSettings();
    if (options?.optimizationGoal) {
      settings.adSet.optimizationGoal = options.optimizationGoal;
    }
    if (options?.defaultsAttribution) {
      settings.adSet.attribution = options.defaultsAttribution;
    }
    if (options?.countries) {
      settings.adSet.targeting.countries = options.countries;
    }
    if (options?.omitDsa) {
      delete settings.identity.beneficiaryName;
      delete settings.identity.payerName;
    }
    await saveDefaults(db.pool, {
      tenantId: db.tenantId,
      advertiserId,
      settings,
      createdBy: userId,
    });

    metricId = uuidv7();
    const bindingAttr = options?.bindingAttribution ?? ["1d_view", "7d_click"];
    await db.pool.query(
      `INSERT INTO conversion_metric (
         id, tenant_id, label, version,
         numerator_action_types, numerator_aggregation, attribution_spec,
         denominator, value_source, effective_from
       ) VALUES (
         $1, $2, 'Lead', 1,
         ARRAY['lead'], 'sum_disjoint', $3::text[],
         NULL, 'none', now() - interval '1 day'
       )`,
      [metricId, db.tenantId, bindingAttr],
    );
    await db.pool.query(
      `INSERT INTO ad_account_metric_assignment (
         id, tenant_id, meta_ad_account_id, conversion_metric_id, effective_from
       ) VALUES ($1, $2, $3, $4, now() - interval '1 day')`,
      [uuidv7(), db.tenantId, accountId, metricId],
    );
    await db.pool.query(
      `INSERT INTO metric_optimization_binding (
         id, tenant_id, conversion_metric_id, conversion_metric_version,
         optimization_goal, promoted_object, attribution_spec,
         version, active
       ) VALUES (
         $1, $2, $3, 1,
         $4, $5::jsonb, $6::text[],
         1, true
       )`,
      [
        uuidv7(),
        db.tenantId,
        metricId,
        options?.bindingGoal ?? "LINK_CLICKS",
        JSON.stringify({ page_id: "page_test" }),
        bindingAttr,
      ],
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
  }

  async function resolveAndPublish(input: {
    budget?: { amount: number; currency: string };
    campaign?:
      | { mode: "new"; budgetMode?: "ABO" | "CBO"; name?: string }
      | { mode: "existing"; existingCampaignId: string };
    adSet?:
      | { mode: "new"; name?: string }
      | { mode: "existing"; existingAdSetId: string };
    deviationReason?: string;
  }) {
    const human = PublishHumanInputSchema.parse({
      advertiserId,
      metaAdAccountId: accountId,
      creativeIds: [creativeId],
      campaign: input.campaign ?? { mode: "new", budgetMode: "ABO" },
      adSet: input.adSet ?? { mode: "new" },
      idempotencyKey: uuidv7(),
      budget: input.budget,
      deviationReason: input.deviationReason,
    });
    const resolved = await resolvePublishPayload(db.pool, {
      tenantId: db.tenantId,
      userId,
      input: human,
      allowHumanBudget: true,
      campaignReader:
        human.campaign.mode === "existing"
          ? {
              getCampaign: (id) => mock.getCampaign(id),
            }
          : undefined,
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
    const outcome = await runPublication(db.pool, {
      publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
      leaseMs: 60_000,
    });
    return { resolved, publicationId, outcome, runId };
  }

  beforeAll(async () => {
    db = await startTestDb();
    setPoolForTests(db.pool);
  }, 60_000);

  afterAll(async () => {
    setCrashAfterPersistForTests(null);
    setPublishClockForTests(null);
    setObjectStoreForTests(null);
    setPoolForTests(null);
    await db.stop();
  });

  beforeEach(async () => {
    setCrashAfterPersistForTests(null);
    setPublishClockForTests(null);
    store = new MemoryObjectStore();
    setObjectStoreForTests(store);
    mock = new MockMetaWriteClient();

    await db.pool.query(`DELETE FROM publication_step`);
    await db.pool.query(`DELETE FROM publication`);
    await db.pool.query(`DELETE FROM metric_optimization_binding`);
    await db.pool.query(`DELETE FROM ad_account_metric_assignment`);
    await db.pool.query(`DELETE FROM conversion_metric`);
    await db.pool.query(`DELETE FROM advertiser_defaults`);
    await db.pool.query(`DELETE FROM creative_variant`);
    await db.pool.query(`DELETE FROM creative`);
    await db.pool.query(`DELETE FROM asset`);
    await db.pool.query(`DELETE FROM meta_ad_account`);
    await db.pool.query(`DELETE FROM meta_connection`);
    await db.pool.query(`DELETE FROM advertiser WHERE tenant_id = $1`, [
      db.tenantId,
    ]);
    await db.pool.query(`DELETE FROM run WHERE tenant_id = $1`, [db.tenantId]);

    await seedFixture();
  });

  it("1 — full publish: every step has external_id and ad is PAUSED", async () => {
    const { publicationId, outcome } = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    expect(outcome.status).toBe("succeeded");

    const steps = await db.pool.query<{
      operation: string;
      status: string;
      external_id: string | null;
    }>(
      `SELECT operation, status, external_id FROM publication_step
       WHERE publication_id = $1 ORDER BY step_index`,
      [publicationId],
    );
    expect(steps.rows).toHaveLength(4);
    for (const step of steps.rows) {
      expect(step.status).toBe("succeeded");
      expect(step.external_id).toBeTruthy();
    }
    const ad = steps.rows.find((s) => s.operation === "create_ad")!;
    const status = await mock.getObjectStatus(ad.external_id!);
    expect(status.status).toBe(META_PUBLISH_STATUS);
    expect(mock.countByKind("campaign")).toBe(1);
  });

  it("2 — fail after create_campaign: resume does not create a second campaign", async () => {
    setCrashAfterPersistForTests(async (op) => {
      if (op === "create_campaign") throw new Error("injected_crash_after_campaign");
    });
    const first = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    expect(first.outcome.status).toBe("failed");
    expect(mock.countByKind("campaign")).toBe(1);

    setCrashAfterPersistForTests(null);
    const resumed = await runPublication(db.pool, {
      publicationId: first.publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    expect(resumed.status).toBe("succeeded");
    expect(mock.countByKind("campaign")).toBe(1);
    expect(mock.countByKind("adset")).toBe(1);
    expect(mock.countByKind("ad")).toBe(1);
  });

  it("3 — fail after create_adset: resume continues at create_creative", async () => {
    setCrashAfterPersistForTests(async (op) => {
      if (op === "create_adset") throw new Error("injected_crash_after_adset");
    });
    const first = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    expect(first.outcome.status).toBe("failed");
    expect(mock.countByKind("adset")).toBe(1);

    setCrashAfterPersistForTests(null);
    const resumed = await runPublication(db.pool, {
      publicationId: first.publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    expect(resumed.status).toBe("succeeded");
    expect(mock.countByKind("campaign")).toBe(1);
    expect(mock.countByKind("adset")).toBe(1);
  });

  it("4 — fail after create_creative: resume continues at create_ad", async () => {
    setCrashAfterPersistForTests(async (op) => {
      if (op === "create_creative") throw new Error("injected_crash_after_creative");
    });
    const first = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    expect(first.outcome.status).toBe("failed");
    expect(mock.countByKind("creative")).toBe(1);

    setCrashAfterPersistForTests(null);
    const resumed = await runPublication(db.pool, {
      publicationId: first.publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    expect(resumed.status).toBe("succeeded");
    expect(mock.countByKind("creative")).toBe(1);
    expect(mock.countByKind("ad")).toBe(1);
  });

  it("5 — fail after create_ad: reconcile finds existing, no second ad", async () => {
    setCrashAfterPersistForTests(async (op) => {
      if (op === "create_ad") throw new Error("injected_crash_after_ad");
    });
    const first = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    expect(first.outcome.status).toBe("failed");
    expect(mock.countByKind("ad")).toBe(1);

    // Simulate lease expiry on the succeeded-but-crashed step: the step was
    // persisted as succeeded before crash, so resume just finishes.
    // For the case where Meta succeeded but DB did not persist: inject fail
    // BEFORE persist by failing the Meta call after object exists — covered
    // by expire+reconcile below using crashAfterSuccess on the mock.
    setCrashAfterPersistForTests(null);
    const resumed = await runPublication(db.pool, {
      publicationId: first.publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    // create_ad was persisted before crash → already succeeded → publication completes
    expect(resumed.status).toBe("succeeded");
    expect(mock.countByKind("ad")).toBe(1);
  });

  it("5b — Meta succeeded but step left in_flight: reconcile finds ad, no duplicate", async () => {
    mock.crashAfterSuccess("create_ad");
    // crashAfterSuccess throws after object is in mock store but before we
    // return — executeStep fails, markStepFailed. That is not in_flight.
    // Explicitly: run until ad step, manually set in_flight with past lease,
    // seed the object, then resume → reconcile.
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

    // Run through creative successfully, then stop before ad by crashing after creative.
    setCrashAfterPersistForTests(async (op) => {
      if (op === "create_creative") throw new Error("stop_before_ad");
    });
    await runPublication(db.pool, {
      publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    setCrashAfterPersistForTests(null);

    const adStep = await db.pool.query<{
      id: string;
      external_correlation: string;
      object_name: string;
    }>(
      `SELECT id, external_correlation, object_name FROM publication_step
       WHERE publication_id = $1 AND operation = 'create_ad'`,
      [publicationId],
    );
    const step = adStep.rows[0]!;
    // Pretend Meta create succeeded under our correlation name, then lease expired.
    const dispatchedAt = new Date(Date.now() - 60_000).toISOString();
    mock.seed("ad_orphaned", "ad", step.object_name, "PAUSED", {
      createdTime: new Date(Date.now() - 30_000).toISOString(),
    });
    await db.pool.query(
      `UPDATE publication_step
       SET status = 'in_flight',
           attempt = 1,
           dispatched_at = $2::timestamptz,
           lease_expires_at = now() - interval '1 minute',
           updated_at = now()
       WHERE id = $1`,
      [step.id, dispatchedAt],
    );
    await db.pool.query(
      `UPDATE publication SET status = 'in_progress' WHERE id = $1`,
      [publicationId],
    );

    const resumed = await runPublication(db.pool, {
      publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    expect(resumed.status).toBe("succeeded");
    expect(mock.countByKind("ad")).toBe(1);

    const final = await db.pool.query<{
      status: string;
      external_id: string | null;
      reconcile_state: string;
    }>(
      `SELECT status, external_id, reconcile_state FROM publication_step WHERE id = $1`,
      [step.id],
    );
    expect(final.rows[0]?.status).toBe("succeeded");
    expect(final.rows[0]?.external_id).toBe("ad_orphaned");
    expect(final.rows[0]?.reconcile_state).toBe("resolved");
  });

  it("6 — expired in_flight with no object → needs_human_review, not retry", async () => {
    const { publicationId } = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    // Reset to simulate mid-flight expiry with nothing at Meta.
    await db.pool.query(`DELETE FROM publication_step WHERE publication_id = $1`, [
      publicationId,
    ]);
    // Recreate a single pending campaign step as expired in_flight.
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
    const created = await createPublication(db.pool, {
      tenantId: db.tenantId,
      runId,
      payload: resolved,
    });
    mock.clearFaults();
    // Clear mock objects so search finds nothing.
    for (const id of [...mock.objects.keys()]) mock.objects.delete(id);

    await db.pool.query(
      `UPDATE publication_step
       SET status = 'in_flight',
           attempt = 1,
           lease_expires_at = now() - interval '2 minutes'
       WHERE publication_id = $1 AND operation = 'create_campaign'`,
      [created.publicationId],
    );
    await db.pool.query(
      `UPDATE publication SET status = 'in_progress' WHERE id = $1`,
      [created.publicationId],
    );

    const campaignsBefore = mock.countByKind("campaign");
    const outcome = await runPublication(db.pool, {
      publicationId: created.publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    expect(outcome.status).toBe("needs_human_review");
    expect(mock.countByKind("campaign")).toBe(campaignsBefore);

    const step = await db.pool.query<{ reconcile_state: string }>(
      `SELECT reconcile_state FROM publication_step
       WHERE publication_id = $1 AND operation = 'create_campaign'`,
      [created.publicationId],
    );
    expect(step.rows[0]?.reconcile_state).toBe("needs_human_review");
  });

  it("7 — binding mismatch is rejected without reason; accepted with reason stored", async () => {
    // Remount fixture with mismatched goals.
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
    await seedFixture({
      optimizationGoal: "OFFSITE_CONVERSIONS",
      bindingGoal: "LEAD_GENERATION",
    });

    await expect(
      resolveAndPublish({ budget: { amount: 1000, currency: "EUR" } }),
    ).rejects.toMatchObject({ code: "metric_binding_mismatch" });

    const { publicationId, resolved } = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
      deviationReason: "Launching purchase ads while dashboard tracks leads",
    });
    expect(resolved.bindingMismatch).toBe(true);
    expect(resolved.deviationReason).toContain("Launching");

    const pub = await db.pool.query<{ deviation_reason: string | null }>(
      `SELECT deviation_reason FROM publication WHERE id = $1`,
      [publicationId],
    );
    expect(pub.rows[0]?.deviation_reason).toContain("Launching");
  });

  it("8 — missing budget → budget_required; no Meta objects", async () => {
    await expect(
      resolveAndPublish({}),
    ).rejects.toMatchObject({ code: "budget_required" });
    expect(mock.countByKind("campaign")).toBe(0);
  });

  it("9 — no path to ACTIVE: schema, sealed payload, write client, source scan", async () => {
    // Agent schema rejects status.
    const agentParsed = PublishAgentInputSchema.safeParse({
      advertiserId,
      metaAdAccountId: accountId,
      creativeIds: [creativeId],
      campaign: { mode: "new" },
      adSet: { mode: "new" },
      idempotencyKey: uuidv7(),
      status: "ACTIVE",
    });
    // Zod strips unknown keys by default — status must not survive.
    expect(agentParsed.success).toBe(true);
    expect(agentParsed.data).not.toHaveProperty("status");
    expect(JSON.stringify(PublishAgentInputSchema.shape)).not.toMatch(/status/);
    expect(JSON.stringify(PublishHumanInputSchema.shape)).not.toMatch(/ACTIVE/);

    const { resolved, outcome } = await resolveAndPublish({
      budget: { amount: 500, currency: "EUR" },
    });
    expect(resolved.status).toBe("PAUSED");
    expect(outcome.status).toBe("succeeded");

    for (const call of mock.calls) {
      if (
        call.operation === "create_campaign" ||
        call.operation === "create_adset" ||
        call.operation === "create_ad"
      ) {
        const args = call.args as Record<string, unknown>;
        // Write client sets PAUSED internally; args must never carry ACTIVE.
        expect(JSON.stringify(args)).not.toMatch(/ACTIVE/);
      }
    }

    // Source scan: publish path must not contain ACTIVE assignment.
    const roots = [
      join(__dirname, "..", "src", "publish"),
      join(__dirname, "..", "src", "meta", "write-client.ts"),
      join(__dirname, "..", "src", "app", "api", "meta", "publish"),
      join(__dirname, "..", "src", "agent", "tools", "publish-ads.ts"),
    ];
    const offenders: string[] = [];
    function scan(path: string) {
      const st = statSync(path);
      if (st.isDirectory()) {
        for (const entry of readdirSync(path)) scan(join(path, entry));
        return;
      }
      if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return;
      const text = readFileSync(path, "utf8");
      // Allow mentions in comments/strings that refuse ACTIVE, but not status: "ACTIVE"
      if (/status\s*[:=]\s*["']ACTIVE["']/.test(text)) {
        offenders.push(path);
      }
    }
    for (const root of roots) scan(root);
    expect(offenders).toEqual([]);
  });

  it("10 — existing ABO campaign: step succeeded with that id, no create call", async () => {
    mock.seed("camp_existing", "campaign", "Existing Camp", "PAUSED", {
      dailyBudget: null,
      lifetimeBudget: null,
    });
    const { publicationId, outcome, resolved } = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
      campaign: { mode: "existing", existingCampaignId: "camp_existing" },
      adSet: { mode: "new" },
    });
    expect(outcome.status).toBe("succeeded");
    expect(resolved.budgetMode).toBe("ABO");
    expect(resolved.budgetSource?.level).toBe("adset");

    const campStep = await db.pool.query<{
      status: string;
      external_id: string | null;
    }>(
      `SELECT status, external_id FROM publication_step
       WHERE publication_id = $1 AND operation = 'create_campaign'`,
      [publicationId],
    );
    expect(campStep.rows[0]?.status).toBe("succeeded");
    expect(campStep.rows[0]?.external_id).toBe("camp_existing");
    expect(
      mock.calls.filter((c) => c.operation === "create_campaign"),
    ).toHaveLength(0);
    expect(mock.countByKind("adset")).toBe(1);
  });

  it("11 — UTM applied without destroying click ids", () => {
    const url = applyUtmParams(
      "https://example.com/land?fbclid=ABC123&utm_source=old",
      "utm_source=meta&utm_medium=paid&utm_campaign=summer",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("fbclid")).toBe("ABC123");
    expect(parsed.searchParams.get("utm_source")).toBe("meta");
    expect(parsed.searchParams.get("utm_medium")).toBe("paid");
    expect(parsed.searchParams.get("utm_campaign")).toBe("summer");
  });

  it("R18-1 — lost Meta response: resume reconciles, no duplicate, id from search", async () => {
    mock.crashAfterSuccess("create_campaign");
    const first = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    expect(first.outcome.status).toBe("failed");
    expect(first.outcome).toMatchObject({ code: "post_dispatch_uncertain" });
    expect(mock.countByKind("campaign")).toBe(1);

    const stepAfter = await db.pool.query<{
      status: string;
      reconcile_state: string;
      dispatched_at: string | null;
      external_id: string | null;
    }>(
      `SELECT status, reconcile_state, dispatched_at, external_id
       FROM publication_step
       WHERE publication_id = $1 AND operation = 'create_campaign'`,
      [first.publicationId],
    );
    expect(stepAfter.rows[0]?.dispatched_at).toBeTruthy();
    expect(stepAfter.rows[0]?.reconcile_state).toBe("pending");
    expect(stepAfter.rows[0]?.external_id).toBeNull();

    const resumed = await runPublication(db.pool, {
      publicationId: first.publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    expect(resumed.status).toBe("succeeded");
    expect(mock.countByKind("campaign")).toBe(1);

    const final = await db.pool.query<{
      status: string;
      external_id: string | null;
      reconcile_state: string;
    }>(
      `SELECT status, external_id, reconcile_state FROM publication_step
       WHERE publication_id = $1 AND operation = 'create_campaign'`,
      [first.publicationId],
    );
    expect(final.rows[0]?.status).toBe("succeeded");
    expect(final.rows[0]?.external_id).toMatch(/^camp_/);
    expect(final.rows[0]?.reconcile_state).toBe("resolved");
  });

  it("R18-1 mutation — skipping reconcile after dispatch would duplicate", async () => {
    // Documented failure mode: if post-dispatch were marked failed and
    // claimed again without reconcile, a second Meta object appears.
    mock.crashAfterSuccess("create_campaign");
    const first = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    expect(mock.countByKind("campaign")).toBe(1);

    // Mutate: wipe dispatch fence and force failed so claim retries blindly.
    await db.pool.query(
      `UPDATE publication_step
       SET status = 'failed',
           reconcile_state = 'none',
           dispatched_at = NULL,
           lease_expires_at = NULL,
           external_id = NULL
       WHERE publication_id = $1 AND operation = 'create_campaign'`,
      [first.publicationId],
    );
    await db.pool.query(
      `UPDATE publication SET status = 'failed' WHERE id = $1`,
      [first.publicationId],
    );
    mock.clearFaults();
    await runPublication(db.pool, {
      publicationId: first.publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    expect(mock.countByKind("campaign")).toBe(2);
  });

  it("R18-2 — binding attribution wins; mismatch without reason is rejected", async () => {
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
    await seedFixture({
      bindingAttribution: ["1d_click"],
      defaultsAttribution: {
        click: "7d_click",
        view: "1d_view",
        engaged: "none",
      },
    });

    await expect(
      resolveAndPublish({ budget: { amount: 1000, currency: "EUR" } }),
    ).rejects.toMatchObject({ code: "metric_binding_mismatch" });

    const { resolved } = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
      deviationReason: "Binding requires 1d_click for LINK_CLICKS",
    });
    expect(resolved.bindingMismatch).toBe(true);
    expect(resolved.adSet.mode).toBe("new");
    if (resolved.adSet.mode === "new") {
      expect(resolved.adSet.attributionSpec).toEqual([
        { event_type: "CLICK_THROUGH", window_days: 1 },
      ]);
    }
  });

  it("R18-3 — existing CBO from Meta: no budget; wrong budget rejected", async () => {
    mock.seed("camp_cbo", "campaign", "CBO Camp", "PAUSED", {
      dailyBudget: 5000,
      lifetimeBudget: null,
    });

    await expect(
      resolveAndPublish({
        budget: { amount: 1000, currency: "EUR" },
        campaign: { mode: "existing", existingCampaignId: "camp_cbo" },
      }),
    ).rejects.toMatchObject({ code: "budget_wrong_level" });

    const { resolved, outcome } = await resolveAndPublish({
      campaign: { mode: "existing", existingCampaignId: "camp_cbo" },
    });
    expect(resolved.budgetMode).toBe("CBO");
    expect(resolved.budgetSource).toBeUndefined();
    expect(outcome.status).toBe("succeeded");
    const adSetCall = mock.calls.find((c) => c.operation === "create_adset");
    expect(adSetCall).toBeTruthy();
    expect(
      (adSetCall!.args as { dailyBudget?: number }).dailyBudget,
    ).toBeUndefined();
  });

  it("R18-4 — EU targeting without DSA → dsa_details_required before Meta", async () => {
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
    await seedFixture({ omitDsa: true, countries: ["DE"] });

    await expect(
      resolveAndPublish({ budget: { amount: 1000, currency: "EUR" } }),
    ).rejects.toMatchObject({ code: "dsa_details_required" });
    expect(mock.countByKind("campaign")).toBe(0);
  });

  it("R18-4b — saveDefaults preserves DSA when omitted on subsequent save", async () => {
    const latest = await saveDefaults(db.pool, {
      tenantId: db.tenantId,
      advertiserId,
      settings: AdvertiserDefaultsSchema.parse({
        identity: { pageId: "page_test" },
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
    expect(latest.version).toBeGreaterThan(1);

    const loaded = await db.pool.query<{ settings: AdvertiserDefaults }>(
      `SELECT settings FROM advertiser_defaults
       WHERE advertiser_id = $1 ORDER BY version DESC LIMIT 1`,
      [advertiserId],
    );
    const settings = AdvertiserDefaultsSchema.parse(loaded.rows[0]?.settings);
    expect(settings.identity.beneficiaryName).toBe("Test GmbH");
    expect(settings.identity.payerName).toBe("Test GmbH");
  });

  it("R18-5 — start_time uses account timezone (Europe/Berlin), not UTC wall", async () => {
    // Summer: Europe/Berlin is UTC+2. 09:00 local → 07:00Z.
    setPublishClockForTests(Date.parse("2026-07-15T12:00:00.000Z"));
    const { resolved } = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    expect(resolved.adSet.mode).toBe("new");
    if (resolved.adSet.mode === "new") {
      expect(resolved.adSet.startTime).toBe("2026-07-16T07:00:00.000Z");
    }
    setPublishClockForTests(null);
  });

  it("mutation — PAUSED gate: flipping sealed status to ACTIVE is refused", async () => {
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
    const mutated = {
      ...resolved,
      status: "ACTIVE" as unknown as typeof META_PUBLISH_STATUS,
    };
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input, created_at, updated_at)
       VALUES ($1, $2, 'publish_request', 'queued', '{}'::jsonb, now(), now())`,
      [runId, db.tenantId],
    );
    await expect(
      createPublication(db.pool, {
        tenantId: db.tenantId,
        runId,
        payload: mutated as typeof resolved,
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("mutation — budget provenance: agent schema cannot carry budget", () => {
    const parsed = PublishAgentInputSchema.safeParse({
      advertiserId,
      metaAdAccountId: accountId,
      creativeIds: [creativeId],
      campaign: { mode: "new" },
      adSet: { mode: "new" },
      idempotencyKey: uuidv7(),
      budget: { amount: 999, currency: "EUR" },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("budget");

    // CBO matrix still requires human budget at resolve time.
    const placement = resolveBudgetPlacement({
      campaignMode: "new",
      adSetMode: "new",
      budgetMode: "ABO",
    });
    expect(() =>
      requireBudgetSource({
        placement,
        humanBudget: undefined,
        decidedBy: userId,
        decidedAt: new Date().toISOString(),
      }),
    ).toThrow(PublishError);
  });

  it("mutation — resume without duplicate: if create_campaign replayed blindly, test would see 2", async () => {
    setCrashAfterPersistForTests(async (op) => {
      if (op === "create_campaign") throw new Error("crash");
    });
    const first = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    setCrashAfterPersistForTests(null);

    // Production resume:
    await runPublication(db.pool, {
      publicationId: first.publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    expect(mock.countByKind("campaign")).toBe(1);

    // Mutated behaviour would reset the step to pending and call Meta again:
    await db.pool.query(
      `UPDATE publication_step
       SET status = 'pending', external_id = NULL, dispatched_at = NULL,
           reconcile_state = 'none'
       WHERE publication_id = $1 AND operation = 'create_campaign'`,
      [first.publicationId],
    );
    await db.pool.query(
      `UPDATE publication SET status = 'in_progress' WHERE id = $1`,
      [first.publicationId],
    );
    // Remaining steps are succeeded — only campaign would re-run if we cleared them too.
    // Mark later steps pending so the chain continues after the mutated campaign recreate.
    await db.pool.query(
      `UPDATE publication_step
       SET status = 'pending', external_id = NULL, dispatched_at = NULL
       WHERE publication_id = $1 AND operation <> 'create_campaign'`,
      [first.publicationId],
    );
    await runPublication(db.pool, {
      publicationId: first.publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    // This demonstrates the failure mode the production path prevents:
    expect(mock.countByKind("campaign")).toBe(2);
  });

  it("R19-1 — foreign object with matching name is NOT adopted", async () => {
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

    const campStep = await db.pool.query<{
      id: string;
      object_name: string;
      external_correlation: string;
    }>(
      `SELECT id, object_name, external_correlation FROM publication_step
       WHERE publication_id = $1 AND operation = 'create_campaign'`,
      [publicationId],
    );
    const step = campStep.rows[0]!;
    const dispatchedAt = new Date(Date.now() - 30_000).toISOString();

    // Foreign campaign: matching name marker, but wrong objective + old created_time.
    mock.seed("camp_foreign", "campaign", step.object_name, "PAUSED", {
      objective: "OUTCOME_SALES",
      createdTime: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await db.pool.query(
      `UPDATE publication_step
       SET status = 'in_flight',
           attempt = 1,
           dispatched_at = $2::timestamptz,
           reconcile_state = 'pending',
           lease_expires_at = now() - interval '1 minute'
       WHERE id = $1`,
      [step.id, dispatchedAt],
    );
    await db.pool.query(
      `UPDATE publication SET status = 'failed' WHERE id = $1`,
      [publicationId],
    );

    const outcome = await runPublication(db.pool, {
      publicationId,
      tenantId: db.tenantId,
      client: mock,
      store,
    });
    expect(outcome.status).toBe("needs_human_review");

    const final = await db.pool.query<{
      status: string;
      external_id: string | null;
      reconcile_state: string;
      error: { reason?: string } | null;
    }>(
      `SELECT status, external_id, reconcile_state, error FROM publication_step WHERE id = $1`,
      [step.id],
    );
    expect(final.rows[0]?.external_id).toBeNull();
    expect(final.rows[0]?.reconcile_state).toBe("needs_human_review");
    expect(final.rows[0]?.error).toMatchObject({
      reason: expect.stringMatching(
        /created_time_outside_dispatch_window|objective_mismatch/,
      ),
    });
  });

  it("R19-1b — correlation is opaque 128-bit hex, not a uuidv7", async () => {
    const { publicationId } = await resolveAndPublish({
      budget: { amount: 1000, currency: "EUR" },
    });
    const rows = await db.pool.query<{ external_correlation: string }>(
      `SELECT external_correlation FROM publication_step WHERE publication_id = $1`,
      [publicationId],
    );
    for (const row of rows.rows) {
      expect(row.external_correlation).toMatch(/^[0-9a-f]{32}$/);
      // uuidv7 has dashes and a version nibble pattern — ours must not.
      expect(row.external_correlation).not.toContain("-");
    }
  });

  it("R19-3 — form patch preserves undisplayed targeting and attribution", () => {
    const base = AdvertiserDefaultsSchema.parse({
      identity: {
        pageId: "page_1",
        beneficiaryName: "Old GmbH",
        payerName: "Old GmbH",
      },
      adSet: {
        optimizationGoal: "LINK_CLICKS",
        budgetMode: "ABO",
        targeting: {
          countries: ["DE"],
          ageMin: 30,
          ageMax: 40,
          genders: [1],
        },
        placements: {
          advantagePlus: false,
          facebook: false,
          instagram: true,
          audienceNetwork: false,
          messenger: false,
        },
        attribution: {
          click: "1d_click",
          view: "none",
          engaged: "none",
        },
      },
      website: { url: "https://example.com", utmParams: "utm_source=meta" },
      autoNaming: {
        creativeTemplate: "{advertiser}",
        adSetTemplate: "{advertiser}",
        adTemplate: "{creative}",
      },
    });
    const merged = mergeDefaultsFormPatch(base, {
      pageId: "page_1",
      instagramActorId: "",
      beneficiaryName: "Old GmbH",
      payerName: "New Pay GmbH",
      optimizationGoal: "LINK_CLICKS",
      budgetMode: "ABO",
      countries: "DE",
      websiteUrl: "https://example.com",
      utmParams: "utm_source=meta",
      creativeTemplate: "{advertiser}",
      adSetTemplate: "{advertiser}",
      adTemplate: "{creative}",
    });
    expect(merged.identity.payerName).toBe("New Pay GmbH");
    expect(merged.adSet.targeting.ageMin).toBe(30);
    expect(merged.adSet.targeting.ageMax).toBe(40);
    expect(merged.adSet.targeting.genders).toEqual([1]);
    expect(merged.adSet.placements.facebook).toBe(false);
    expect(merged.adSet.placements.instagram).toBe(true);
    expect(merged.adSet.attribution.click).toBe("1d_click");
    expect(merged.adSet.attribution.view).toBe("none");
  });

  it("R19-4 — DSA fails before any Meta campaign read", async () => {
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
    await seedFixture({ omitDsa: true, countries: ["DE"] });
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
        }),
        allowHumanBudget: true,
        campaignReader: {
          getCampaign: async (id) => {
            readerCalls += 1;
            return mock.getCampaign(id);
          },
        },
      }),
    ).rejects.toMatchObject({ code: "dsa_details_required" });
    expect(readerCalls).toBe(0);
  });

  it("R19-5 — unknown binding attribution is rejected by schema", () => {
    expect(
      BindingAttributionSpecSchema.safeParse(["7d_click", "30d_click"]).success,
    ).toBe(false);
    expect(BindingAttributionSpecSchema.safeParse(["1d_click"]).success).toBe(
      true,
    );
  });
});
