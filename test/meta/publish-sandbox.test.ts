/**
 * Live Meta sandbox publish checks (campaign + ad set only).
 *
 * Creative/Ad need a page with can_post and usually a pixel — not available
 * on the sandbox account used for Etappe 7 (see DECISIONS.md).
 *
 * Run: pnpm test:meta-publish
 * Requires: META_SANDBOX_* from _local/adloop-v2/.env.meta
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MetaGraphClient } from "@/meta/graph-client";
import { MetaWriteClient } from "@/meta/write-client";
import { META_PUBLISH_STATUS } from "@/publish/schemas";

function loadSandboxEnv(): {
  adAccountId: string;
  accessToken: string;
  pageId: string;
  apiVersion: string;
} | null {
  const envPath = resolve(
    process.env.META_ENV_FILE ??
      `${process.env.HOME}/hq/repos/projekte/adloop/_local/adloop-v2/.env.meta`,
  );
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf8");
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) map[m[1]!] = m[2]!;
  }
  if (
    !map.META_SANDBOX_AD_ACCOUNT_ID ||
    !map.META_SANDBOX_ACCESS_TOKEN ||
    !map.META_SANDBOX_PAGE_ID
  ) {
    return null;
  }
  return {
    adAccountId: map.META_SANDBOX_AD_ACCOUNT_ID,
    accessToken: map.META_SANDBOX_ACCESS_TOKEN,
    pageId: map.META_SANDBOX_PAGE_ID,
    apiVersion: map.META_API_VERSION ?? "v21.0",
  };
}

const sandbox = loadSandboxEnv();

describe.runIf(Boolean(sandbox))("meta sandbox publish (campaign + adset)", () => {
  const created: string[] = [];
  let client: MetaWriteClient;

  afterAll(async () => {
    for (const id of created.reverse()) {
      try {
        await client.deleteObject(id);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("creates PAUSED campaign+adset, resumes after injected gap, cleans up", async () => {
    if (!sandbox) return;
    const graph = new MetaGraphClient({
      accessToken: sandbox.accessToken,
      apiVersion: sandbox.apiVersion,
    });
    client = new MetaWriteClient(graph);
    const correlation = `e7-${Date.now()}`;
    const campaignName = `adloop sandbox ${correlation} [adloop:${correlation}-camp]`;

    const campaign = await client.createCampaign({
      adAccountId: sandbox.adAccountId,
      name: campaignName,
      objective: "OUTCOME_TRAFFIC",
      isAdsetBudgetSharingEnabled: false,
    });
    created.push(campaign.id);

    const campStatus = await client.getObjectStatus(campaign.id);
    expect(campStatus.status).toBe(META_PUBLISH_STATUS);

    // Simulate "resume after campaign": do not create a second campaign;
    // search by correlation and continue with ad set.
    const found = await client.searchByName({
      adAccountId: sandbox.adAccountId,
      edge: "campaigns",
      nameContains: `[adloop:${correlation}-camp]`,
    });
    expect(found.some((row) => row.id === campaign.id)).toBe(true);
    expect(found.filter((row) => row.name.includes(correlation)).length).toBe(1);

    const adSetName = `adloop sandbox adset ${correlation} [adloop:${correlation}-adset]`;
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const adSet = await client.createAdSet({
      adAccountId: sandbox.adAccountId,
      campaignId: campaign.id,
      name: adSetName,
      optimizationGoal: "LINK_CLICKS",
      billingEvent: "IMPRESSIONS",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      dailyBudget: 1000,
      // US avoids EU DSA beneficiary requirement on this sandbox account.
      targeting: { geo_locations: { countries: ["US"] }, age_min: 18, age_max: 65 },
      // LINK_CLICKS on OUTCOME_TRAFFIC only supports 1-day click attribution.
      attributionSpec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
      startTime: start,
    });
    created.push(adSet.id);

    const adSetStatus = await client.getObjectStatus(adSet.id);
    expect(adSetStatus.status).toBe(META_PUBLISH_STATUS);

    // Existing-campaign prerequisite for fall 10: we created it above and
    // would attach a new ad set; already done. Cleanup in afterAll.
  }, 120_000);
});

describe.runIf(!sandbox)("meta sandbox publish (skipped)", () => {
  it("skips when META_SANDBOX_* env is missing", () => {
    expect(sandbox).toBeNull();
  });
});
