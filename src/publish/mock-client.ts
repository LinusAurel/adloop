import type { MetaNamedObject, MetaWriteClient } from "@/meta/write-client";
import type { PublishStepOperation } from "./schemas";

export type MockWriteCall = {
  operation: PublishStepOperation | "upload_image" | "search" | "get_status" | "delete";
  args: unknown;
};

/**
 * In-memory Meta write client for the full publish chain. Supports
 * per-operation fault injection so resume tests hit the production path.
 */
export class MockMetaWriteClient implements Pick<
  MetaWriteClient,
  | "createCampaign"
  | "createAdSet"
  | "uploadAdImage"
  | "createAdCreative"
  | "createAd"
  | "getObjectStatus"
  | "getCampaign"
  | "searchByName"
  | "deleteObject"
> {
  readonly calls: MockWriteCall[] = [];
  readonly objects = new Map<
    string,
    { kind: string; name: string; status: string; meta: Record<string, unknown> }
  >();

  private seq = 1;
  private failNext = new Set<PublishStepOperation | "upload_image">();
  private failAfterSuccess = new Set<PublishStepOperation>();

  failOn(operation: PublishStepOperation | "upload_image"): void {
    this.failNext.add(operation);
  }

  /** Succeed the Meta write, then throw — models lost response after create. */
  crashAfterSuccess(operation: PublishStepOperation): void {
    this.failAfterSuccess.add(operation);
  }

  clearFaults(): void {
    this.failNext.clear();
    this.failAfterSuccess.clear();
  }

  private nextId(prefix: string): string {
    const id = `${prefix}_${this.seq}`;
    this.seq += 1;
    return id;
  }

  private maybeFail(operation: PublishStepOperation | "upload_image"): void {
    if (this.failNext.has(operation)) {
      this.failNext.delete(operation);
      throw new Error(`injected_fail_${operation}`);
    }
  }

  private afterSuccess(operation: PublishStepOperation): void {
    if (this.failAfterSuccess.has(operation)) {
      this.failAfterSuccess.delete(operation);
      throw new Error(`injected_crash_after_${operation}`);
    }
  }

  async createCampaign(params: {
    adAccountId: string;
    name: string;
    objective: string;
    isAdsetBudgetSharingEnabled: boolean;
    dailyBudget?: number;
    signal?: AbortSignal;
  }): Promise<{ id: string }> {
    this.calls.push({ operation: "create_campaign", args: params });
    this.maybeFail("create_campaign");
    const id = this.nextId("camp");
    this.objects.set(id, {
      kind: "campaign",
      name: params.name,
      status: "PAUSED",
      meta: {
        ...params,
        status: "PAUSED",
        dailyBudget: params.dailyBudget ?? null,
        lifetimeBudget: null,
      },
    });
    this.afterSuccess("create_campaign");
    return { id };
  }

  async createAdSet(params: {
    adAccountId: string;
    campaignId: string;
    name: string;
    optimizationGoal: string;
    billingEvent: string;
    bidStrategy: string;
    bidAmount?: number;
    dailyBudget?: number;
    targeting: Record<string, unknown>;
    attributionSpec: Array<{ event_type: string; window_days: number }>;
    promotedObject?: Record<string, unknown>;
    startTime: string;
    dsaBeneficiary?: string;
    dsaPayor?: string;
    signal?: AbortSignal;
  }): Promise<{ id: string }> {
    this.calls.push({ operation: "create_adset", args: params });
    this.maybeFail("create_adset");
    const id = this.nextId("adset");
    this.objects.set(id, {
      kind: "adset",
      name: params.name,
      status: "PAUSED",
      meta: { ...params, status: "PAUSED" },
    });
    this.afterSuccess("create_adset");
    return { id };
  }

  async uploadAdImage(params: {
    adAccountId: string;
    bytes: Buffer;
    filename: string;
    signal?: AbortSignal;
  }): Promise<{ hash: string }> {
    this.calls.push({ operation: "upload_image", args: { filename: params.filename } });
    this.maybeFail("upload_image");
    return { hash: `hash_${params.filename}` };
  }

  async createAdCreative(params: {
    adAccountId: string;
    name: string;
    pageId: string;
    instagramActorId?: string;
    imageHash: string;
    linkUrl: string;
    message: string;
    headline: string;
    description: string;
    callToAction: string;
    signal?: AbortSignal;
  }): Promise<{ id: string }> {
    this.calls.push({ operation: "create_creative", args: params });
    this.maybeFail("create_creative");
    const id = this.nextId("creative");
    this.objects.set(id, {
      kind: "creative",
      name: params.name,
      status: "PAUSED",
      meta: { ...params },
    });
    this.afterSuccess("create_creative");
    return { id };
  }

  async createAd(params: {
    adAccountId: string;
    adSetId: string;
    creativeId: string;
    name: string;
    signal?: AbortSignal;
  }): Promise<{ id: string }> {
    this.calls.push({ operation: "create_ad", args: params });
    this.maybeFail("create_ad");
    const id = this.nextId("ad");
    this.objects.set(id, {
      kind: "ad",
      name: params.name,
      status: "PAUSED",
      meta: { ...params, status: "PAUSED" },
    });
    this.afterSuccess("create_ad");
    return { id };
  }

  async getObjectStatus(objectId: string): Promise<{
    id: string;
    status?: string;
    name?: string;
  }> {
    this.calls.push({ operation: "get_status", args: { objectId } });
    const obj = this.objects.get(objectId);
    if (!obj) throw new Error(`mock_missing_${objectId}`);
    return { id: objectId, status: obj.status, name: obj.name };
  }

  async getCampaign(campaignId: string): Promise<{
    id: string;
    name?: string;
    dailyBudget: number | null;
    lifetimeBudget: number | null;
  }> {
    this.calls.push({ operation: "get_status", args: { getCampaign: campaignId } });
    const obj = this.objects.get(campaignId);
    if (!obj || obj.kind !== "campaign") {
      throw new Error(`mock_campaign_missing_${campaignId}`);
    }
    const daily = obj.meta.dailyBudget;
    const lifetime = obj.meta.lifetimeBudget;
    return {
      id: campaignId,
      name: obj.name,
      dailyBudget: typeof daily === "number" ? daily : null,
      lifetimeBudget: typeof lifetime === "number" ? lifetime : null,
    };
  }

  async searchByName(params: {
    adAccountId: string;
    edge: "campaigns" | "adsets" | "ads" | "adcreatives";
    nameContains: string;
    signal?: AbortSignal;
  }): Promise<MetaNamedObject[]> {
    this.calls.push({ operation: "search", args: params });
    const kindMap = {
      campaigns: "campaign",
      adsets: "adset",
      ads: "ad",
      adcreatives: "creative",
    } as const;
    const kind = kindMap[params.edge];
    const results: MetaNamedObject[] = [];
    for (const [id, obj] of this.objects) {
      if (obj.kind === kind && obj.name.includes(params.nameContains)) {
        results.push({
          id,
          name: obj.name,
          status: obj.status,
          created_time: new Date().toISOString(),
        });
      }
    }
    return results;
  }

  async deleteObject(objectId: string): Promise<void> {
    this.calls.push({ operation: "delete", args: { objectId } });
    this.objects.delete(objectId);
  }

  countByKind(kind: string): number {
    let n = 0;
    for (const obj of this.objects.values()) {
      if (obj.kind === kind) n += 1;
    }
    return n;
  }

  /** Seed an existing object (for "existing campaign" tests). */
  seed(
    id: string,
    kind: string,
    name: string,
    status = "PAUSED",
    meta: Record<string, unknown> = {},
  ): void {
    this.objects.set(id, { kind, name, status, meta });
  }
}
