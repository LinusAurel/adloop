import { z } from "zod";
import { MetaGraphClient } from "./graph-client";
import { META_PUBLISH_STATUS } from "@/publish/schemas";

const IdResponseSchema = z.object({ id: z.string().min(1) });

const ImageUploadResponseSchema = z.object({
  images: z.record(
    z.object({
      hash: z.string().min(1),
      url: z.string().optional(),
      name: z.string().optional(),
    }),
  ),
});

const NamedObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: z.string().optional(),
  created_time: z.string().optional(),
});

const NamedListSchema = z.object({
  data: z.array(NamedObjectSchema),
  paging: z
    .object({
      next: z.string().optional(),
      cursors: z.object({ after: z.string().optional() }).optional(),
    })
    .optional(),
});

export type MetaNamedObject = z.infer<typeof NamedObjectSchema>;

function assertPausedOnly(status: string): void {
  if (status !== META_PUBLISH_STATUS) {
    throw new Error(`meta_write_refused_non_paused:${status}`);
  }
}

/**
 * Write paths for Meta Marketing API. Every create sets status=PAUSED
 * explicitly — a Meta default changing would still not produce ACTIVE.
 */
export class MetaWriteClient {
  constructor(private readonly graph: MetaGraphClient) {}

  async createCampaign(params: {
    adAccountId: string; // act_…
    name: string;
    objective: string;
    isAdsetBudgetSharingEnabled: boolean;
    dailyBudget?: number;
    signal?: AbortSignal;
  }): Promise<{ id: string }> {
    assertPausedOnly(META_PUBLISH_STATUS);
    const body = new URLSearchParams({
      name: params.name,
      objective: params.objective,
      status: META_PUBLISH_STATUS,
      special_ad_categories: "[]",
      is_adset_budget_sharing_enabled: params.isAdsetBudgetSharingEnabled
        ? "true"
        : "false",
    });
    if (params.dailyBudget !== undefined) {
      body.set("daily_budget", String(params.dailyBudget));
    }
    const response = await this.graph.request(
      `/${params.adAccountId}/campaigns`,
      IdResponseSchema,
      { method: "POST", body, signal: params.signal },
    );
    return response.data;
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
    assertPausedOnly(META_PUBLISH_STATUS);
    const body = new URLSearchParams({
      campaign_id: params.campaignId,
      name: params.name,
      optimization_goal: params.optimizationGoal,
      billing_event: params.billingEvent,
      bid_strategy: params.bidStrategy,
      status: META_PUBLISH_STATUS,
      targeting: JSON.stringify(params.targeting),
      attribution_spec: JSON.stringify(params.attributionSpec),
      start_time: params.startTime,
    });
    if (params.bidAmount !== undefined) {
      body.set("bid_amount", String(params.bidAmount));
    }
    if (params.dailyBudget !== undefined) {
      body.set("daily_budget", String(params.dailyBudget));
    }
    if (params.promotedObject) {
      body.set("promoted_object", JSON.stringify(params.promotedObject));
    }
    if (params.dsaBeneficiary) {
      body.set("dsa_beneficiary", params.dsaBeneficiary);
    }
    if (params.dsaPayor) {
      body.set("dsa_payor", params.dsaPayor);
    }
    const response = await this.graph.request(
      `/${params.adAccountId}/adsets`,
      IdResponseSchema,
      { method: "POST", body, signal: params.signal },
    );
    return response.data;
  }

  async uploadAdImage(params: {
    adAccountId: string;
    bytes: Buffer;
    filename: string;
    signal?: AbortSignal;
  }): Promise<{ hash: string }> {
    // Graph accepts bytes as multipart; for simplicity we use base64 bytes
    // field which Meta documents for adimages.
    const body = new URLSearchParams({
      bytes: params.bytes.toString("base64"),
      name: params.filename,
    });
    const response = await this.graph.request(
      `/${params.adAccountId}/adimages`,
      ImageUploadResponseSchema,
      { method: "POST", body, signal: params.signal },
    );
    const first = Object.values(response.data.images)[0];
    if (!first) throw new Error("meta_image_upload_empty");
    return { hash: first.hash };
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
    const objectStorySpec: Record<string, unknown> = {
      page_id: params.pageId,
      link_data: {
        image_hash: params.imageHash,
        link: params.linkUrl,
        message: params.message,
        name: params.headline,
        description: params.description,
        call_to_action: {
          type: params.callToAction,
          value: { link: params.linkUrl },
        },
      },
    };
    if (params.instagramActorId) {
      objectStorySpec.instagram_actor_id = params.instagramActorId;
    }
    const body = new URLSearchParams({
      name: params.name,
      object_story_spec: JSON.stringify(objectStorySpec),
    });
    const response = await this.graph.request(
      `/${params.adAccountId}/adcreatives`,
      IdResponseSchema,
      { method: "POST", body, signal: params.signal },
    );
    return response.data;
  }

  async createAd(params: {
    adAccountId: string;
    adSetId: string;
    creativeId: string;
    name: string;
    signal?: AbortSignal;
  }): Promise<{ id: string }> {
    assertPausedOnly(META_PUBLISH_STATUS);
    const body = new URLSearchParams({
      name: params.name,
      adset_id: params.adSetId,
      creative: JSON.stringify({ creative_id: params.creativeId }),
      status: META_PUBLISH_STATUS,
    });
    const response = await this.graph.request(
      `/${params.adAccountId}/ads`,
      IdResponseSchema,
      { method: "POST", body, signal: params.signal },
    );
    return response.data;
  }

  async getObjectStatus(
    objectId: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; status?: string; name?: string }> {
    const response = await this.graph.request(
      `/${objectId}?fields=id,name,status`,
      NamedObjectSchema,
      { signal },
    );
    return response.data;
  }

  async searchByName(params: {
    adAccountId: string;
    edge: "campaigns" | "adsets" | "ads" | "adcreatives";
    nameContains: string;
    signal?: AbortSignal;
  }): Promise<MetaNamedObject[]> {
    const path =
      `/${params.adAccountId}/${params.edge}` +
      `?fields=id,name,status,created_time&limit=50`;
    const response = await this.graph.request(path, NamedListSchema, {
      signal: params.signal,
    });
    return response.data.data.filter((row) =>
      row.name.includes(params.nameContains),
    );
  }

  async deleteObject(objectId: string, signal?: AbortSignal): Promise<void> {
    await this.graph.request(
      `/${objectId}`,
      z.object({ success: z.boolean().optional() }).passthrough(),
      { method: "DELETE", signal },
    );
  }
}
