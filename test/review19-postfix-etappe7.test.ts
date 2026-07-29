/**
 * Review 19 / Finding 2: post_dispatch_uncertain must retry via the queue,
 * not return as a terminal job result. The worker must discover the retry
 * on its own (startWorker), not a hand-rolled second runPublication call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { setPoolForTests } from "@/db/pool";
import {
  type TestDb,
  startTestDb,
  sleep,
} from "./db-harness";
import {
  MemoryObjectStore,
  setObjectStoreForTests,
} from "@/storage/object-store";
import { seedMetaAccount } from "./metrics-fixtures";
import { saveDefaults, resolvePublishPayload } from "@/publish/resolve";
import { createPublication } from "@/publish/chain";
import { MockMetaWriteClient } from "@/publish/mock-client";
import { PublishHumanInputSchema } from "@/publish/schemas";
import { AdvertiserDefaultsSchema } from "@/publish/settings";
import { setWriteClientForTests } from "@/publish/client-factory";
import { clearRegistry, registerFamily } from "@/queue/registry";
import { metaPublishFamily } from "@/queue/families/meta-publish";
import { startWorker } from "@/queue/poll-loop";
import { insertQueuedRun } from "./db-harness";

describe("review 19 — meta_publish queue reconcile", () => {
  let db: TestDb;
  let store: MemoryObjectStore;
  let mock: MockMetaWriteClient;
  let advertiserId: string;
  let accountId: string;
  let creativeId: string;
  let userId: string;

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
    // ResolvedPublishPayloadSchema requires act_<digits> for the Graph id.
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

    const metricId = uuidv7();
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
      [uuidv7(), db.tenantId, metricId, JSON.stringify({ page_id: "page_test" })],
    );

    const assetId = uuidv7();
    const storageKey = `creatives/${assetId}.png`;
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    await store.putBytes(storageKey, png, "image/png");
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

  it("worker autonomously retries post_dispatch_uncertain and reconciles", async () => {
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

    mock.crashAfterSuccess("create_campaign");

    const { jobId } = await insertQueuedRun(db.pool, {
      tenantId: db.tenantId,
      family: "meta_publish",
      input: {
        resolved,
        publicationId,
      },
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
      for (let i = 0; i < 200 && status !== "completed" && status !== "failed"; i += 1) {
        await sleep(50);
        const { rows } = await db.pool.query<{ status: string }>(
          `SELECT status FROM job WHERE id = $1`,
          [jobId],
        );
        status = rows[0]?.status ?? "";
      }
      if (status !== "succeeded") {
        const dump = await db.pool.query(
          `SELECT status, attempts, error FROM job WHERE id = $1`,
          [jobId],
        );
        const steps = await db.pool.query(
          `SELECT operation, status, reconcile_state, error, external_id, dispatched_at
           FROM publication_step WHERE publication_id = $1 ORDER BY step_index`,
          [publicationId],
        );
        console.log("JOB", JSON.stringify(dump.rows[0], null, 2));
        console.log("STEPS", JSON.stringify(steps.rows, null, 2));
        console.log("CALLS", mock.calls.map(c => c.operation));
        console.log("OBJECTS", [...mock.objects.entries()].map(([id,o]) => ({id, kind:o.kind, name:o.name})));
      }
      expect(status).toBe("completed");
    } finally {
      await worker.shutdown();
    }

    expect(mock.countByKind("campaign")).toBe(1);
    const step = await db.pool.query<{
      status: string;
      external_id: string | null;
      reconcile_state: string;
    }>(
      `SELECT status, external_id, reconcile_state FROM publication_step
       WHERE publication_id = $1 AND operation = 'create_campaign'`,
      [publicationId],
    );
    expect(step.rows[0]?.status).toBe("succeeded");
    expect(step.rows[0]?.external_id).toBeTruthy();
    expect(["resolved", "none"]).toContain(step.rows[0]?.reconcile_state);

    const pub = await db.pool.query<{ status: string }>(
      `SELECT status FROM publication WHERE id = $1`,
      [publicationId],
    );
    expect(pub.rows[0]?.status).toBe("succeeded");
  }, 20_000);
});
