import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import {
  completedCount,
  deriveSetupSteps,
  openEssentialSteps,
  type SetupAccountFacts,
  type SetupFacts,
  type SetupStepId,
} from "@/setup/steps";
import { collectSetupFacts } from "@/setup/facts";
import { startTestDb, type TestDb } from "./db-harness";
import { seedMetaAccount, seedSucceededSync, type SeedAccount } from "./metrics-fixtures";

function account(overrides: Partial<SetupAccountFacts> = {}): SetupAccountFacts {
  return {
    id: "account-1",
    name: "Synthetic account",
    hasSucceededSync: true,
    hasAssignedMetric: true,
    hasPublishDefaults: true,
    ...overrides,
  };
}

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    metaConfigured: true,
    connections: 1,
    usableConnections: 1,
    selectedAccounts: [account()],
    imageProviders: ["fal"],
    ...overrides,
  };
}

function byId(all: ReturnType<typeof deriveSetupSteps>, id: SetupStepId) {
  const step = all.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`missing step: ${id}`);
  return step;
}

describe("setup step derivation", () => {
  it("reports every step done for a fully configured installation", () => {
    const steps = deriveSetupSteps(facts());
    expect(steps.map((step) => step.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(completedCount(steps)).toBe(5);
    expect(openEssentialSteps(steps)).toEqual([]);
  });

  it("blocks the connection step when the Meta credentials are absent", () => {
    const steps = deriveSetupSteps(facts({ metaConfigured: false }));
    const step = byId(steps, "meta_connection");
    // Blocked rather than todo: there is no button in the interface that could
    // supply an app secret.
    expect(step.status).toBe("blocked");
    expect(step.reason).toBe("meta_credentials_missing");
  });

  it("tells an expired connection apart from a missing one", () => {
    const missing = byId(
      deriveSetupSteps(facts({ connections: 0, usableConnections: 0 })),
      "meta_connection",
    );
    expect(missing.reason).toBe("no_connection");

    const expired = byId(
      deriveSetupSteps(facts({ connections: 1, usableConnections: 0 })),
      "meta_connection",
    );
    expect(expired.status).toBe("todo");
    expect(expired.reason).toBe("connection_expired");
  });

  it("treats a connection without a selected account as unfinished", () => {
    const step = byId(deriveSetupSteps(facts({ selectedAccounts: [] })), "meta_connection");
    expect(step.status).toBe("todo");
    expect(step.reason).toBe("no_account_selected");
  });

  it("blocks the account-scoped steps while no account is selected", () => {
    const steps = deriveSetupSteps(facts({ selectedAccounts: [] }));
    for (const id of ["insight_sync", "conversion_metric", "advertiser_defaults"] as const) {
      expect(byId(steps, id).status, id).toBe("blocked");
      expect(byId(steps, id).reason, id).toBe("no_account_selected");
    }
  });

  it("names the accounts that are still missing a step", () => {
    const steps = deriveSetupSteps(
      facts({
        selectedAccounts: [
          account({ id: "a", name: "Ready account" }),
          account({ id: "b", name: "Fresh account", hasSucceededSync: false, hasAssignedMetric: false }),
        ],
      }),
    );
    const sync = byId(steps, "insight_sync");
    expect(sync.status).toBe("todo");
    expect(sync.pendingAccounts).toEqual(["Fresh account"]);
    expect(byId(steps, "conversion_metric").pendingAccounts).toEqual(["Fresh account"]);
    // One account being ready does not make the step done for the tenant.
    expect(byId(steps, "advertiser_defaults").status).toBe("done");
  });

  it("keeps the image provider independent of Meta", () => {
    const withoutMeta = deriveSetupSteps(
      facts({ metaConfigured: false, selectedAccounts: [], imageProviders: ["fal"] }),
    );
    expect(byId(withoutMeta, "image_provider").status).toBe("done");

    const withoutProvider = deriveSetupSteps(facts({ imageProviders: [] }));
    const step = byId(withoutProvider, "image_provider");
    expect(step.status).toBe("todo");
    expect(step.reason).toBe("provider_missing");
    // Not essential: it gates the workshop, nothing else.
    expect(step.essential).toBe(false);
    expect(openEssentialSteps(withoutProvider)).toEqual([]);
  });

  it("counts only the three essential steps as worth interrupting somebody", () => {
    const steps = deriveSetupSteps(
      facts({
        selectedAccounts: [
          account({ hasSucceededSync: false, hasAssignedMetric: false, hasPublishDefaults: false }),
        ],
        imageProviders: [],
      }),
    );
    expect(openEssentialSteps(steps)).toEqual(["insight_sync", "conversion_metric"]);
    expect(completedCount(steps)).toBe(1);
  });
});

describe("setup facts read from the database", () => {
  let db: TestDb;
  let seeded: SeedAccount;

  beforeAll(async () => {
    db = await startTestDb();
    seeded = await seedMetaAccount(db.pool, db.tenantId);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("derives every account fact from the owning table", async () => {
    const before = await collectSetupFacts(db.pool, db.tenantId);
    expect(before.connections).toBe(1);
    expect(before.usableConnections).toBe(1);
    expect(before.selectedAccounts).toHaveLength(1);
    expect(before.selectedAccounts[0]).toMatchObject({
      hasSucceededSync: false,
      hasAssignedMetric: false,
      hasPublishDefaults: false,
    });

    await seedSucceededSync(db.pool, {
      tenantId: db.tenantId,
      accountId: seeded.accountId,
      windowStart: "2026-06-01",
      windowEnd: "2026-06-30",
    });

    const metricId = uuidv7();
    await db.pool.query(
      `INSERT INTO conversion_metric (
         id, tenant_id, label, version, numerator_action_types,
         numerator_aggregation, attribution_spec, denominator, value_source,
         effective_from
       ) VALUES (
         $1, $2, 'Anfragen', 1, ARRAY['offsite_conversion.fb_pixel_lead'],
         'coalesce_aliases', ARRAY['1d_view','7d_click'], 'link_clicks', 'none',
         now()
       )`,
      [metricId, db.tenantId],
    );

    // A metric that exists but is assigned nowhere leaves the account on the
    // fallback definition — the step must stay open.
    const unassigned = await collectSetupFacts(db.pool, db.tenantId);
    expect(unassigned.selectedAccounts[0]?.hasSucceededSync).toBe(true);
    expect(unassigned.selectedAccounts[0]?.hasAssignedMetric).toBe(false);

    await db.pool.query(
      `INSERT INTO ad_account_metric_assignment (
         id, tenant_id, meta_ad_account_id, conversion_metric_id, effective_from
       ) VALUES ($1, $2, $3, $4, now())`,
      [uuidv7(), db.tenantId, seeded.accountId, metricId],
    );

    const assigned = await collectSetupFacts(db.pool, db.tenantId);
    expect(assigned.selectedAccounts[0]?.hasAssignedMetric).toBe(true);
    expect(assigned.selectedAccounts[0]?.hasPublishDefaults).toBe(false);

    await db.pool.query(
      `INSERT INTO advertiser_defaults (id, tenant_id, advertiser_id, version, settings)
       VALUES ($1, $2, $3, 1, $4::jsonb)`,
      [
        uuidv7(),
        db.tenantId,
        seeded.advertiserId,
        JSON.stringify({ identity: { pageId: "1234567890" } }),
      ],
    );

    const complete = await collectSetupFacts(db.pool, db.tenantId);
    expect(complete.selectedAccounts[0]?.hasPublishDefaults).toBe(true);
  });

  it("ignores a stored defaults row whose page id is empty", async () => {
    const other = await seedMetaAccount(db.pool, db.tenantId);
    await db.pool.query(
      `INSERT INTO advertiser_defaults (id, tenant_id, advertiser_id, version, settings)
       VALUES ($1, $2, $3, 1, $4::jsonb)`,
      [uuidv7(), db.tenantId, other.advertiserId, JSON.stringify({ identity: { pageId: "" } })],
    );

    const collected = await collectSetupFacts(db.pool, db.tenantId);
    const row = collected.selectedAccounts.find((a) => a.id === other.accountId);
    expect(row?.hasPublishDefaults).toBe(false);
  });

  it("does not count an expired connection as usable", async () => {
    await db.pool.query(
      `UPDATE meta_connection
       SET token_expires_at = now() - interval '1 day'
       WHERE tenant_id = $1`,
      [db.tenantId],
    );
    const collected = await collectSetupFacts(db.pool, db.tenantId);
    expect(collected.connections).toBeGreaterThan(0);
    expect(collected.usableConnections).toBe(0);
  });

  it("keeps one tenant's setup state out of another's", async () => {
    const otherTenant = uuidv7();
    await db.pool.query(`INSERT INTO tenant (id, name) VALUES ($1, 'Other tenant')`, [
      otherTenant,
    ]);
    const collected = await collectSetupFacts(db.pool, otherTenant);
    expect(collected.connections).toBe(0);
    expect(collected.selectedAccounts).toEqual([]);
  });
});
