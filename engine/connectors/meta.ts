// Meta Graph API connector (SPEC §5): direct fetch against v25.0, no SDK.
// HARD RULE (AGENTS.md Hard Stop 2): every campaign, ad set, and ad is
// created with status PAUSED — the functions do not even accept a status
// parameter. Activation happens exclusively by a human in Ads Manager.
// Secrets come from env and are NEVER logged.

const GRAPH = "https://graph.facebook.com/v25.0";

function env(name: "META_ACCESS_TOKEN" | "META_AD_ACCOUNT_ID"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} fehlt (.env)`);
  return v;
}

function actId(): string {
  return `act_${env("META_AD_ACCOUNT_ID")}`;
}

async function graphRequest<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const token = env("META_ACCESS_TOKEN");
  const url = new URL(`${GRAPH}/${path}`);
  let body: URLSearchParams | undefined;
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", token);
  } else {
    body = new URLSearchParams({ ...params, access_token: token });
  }
  const res = await fetch(url, { method, body });
  const json = (await res.json()) as T & { error?: { message?: string; type?: string; code?: number } };
  if (!res.ok || json.error) {
    // Only the Graph error message — never the token or full request.
    throw new Error(
      `Meta Graph ${method} /${path} fehlgeschlagen: ${json.error?.message ?? res.status} (code ${json.error?.code ?? res.status})`,
    );
  }
  return json;
}

export async function createCampaign(args: {
  name: string;
  dailyBudgetCents: number;
  specialAdCategories?: string[];
}): Promise<{ id: string }> {
  return graphRequest("POST", `${actId()}/campaigns`, {
    name: args.name,
    objective: "OUTCOME_LEADS",
    status: "PAUSED",
    special_ad_categories: JSON.stringify(args.specialAdCategories ?? []),
    daily_budget: String(args.dailyBudgetCents),
  });
}

export async function createAdSet(args: {
  name: string;
  campaignId: string;
  pixelId: string;
  leadEventName: string;
  geoCountries: string[];
  optimizationGoal: string;
  billingEvent: string;
}): Promise<{ id: string }> {
  return graphRequest("POST", `${actId()}/adsets`, {
    name: args.name,
    campaign_id: args.campaignId,
    status: "PAUSED",
    optimization_goal: args.optimizationGoal,
    billing_event: args.billingEvent,
    targeting: JSON.stringify({ geo_locations: { countries: args.geoCountries } }),
    promoted_object: JSON.stringify({
      pixel_id: args.pixelId,
      custom_event_type: "OTHER",
      custom_event_str: args.leadEventName,
    }),
  });
}

// Upload image bytes -> image_hash for creatives.
export async function uploadImage(imageBytes: Buffer, name: string): Promise<string> {
  const result = await graphRequest<{ images: Record<string, { hash: string }> }>(
    "POST",
    `${actId()}/adimages`,
    { bytes: imageBytes.toString("base64"), name },
  );
  const first = Object.values(result.images ?? {})[0];
  if (!first?.hash) throw new Error("Meta adimages: kein image_hash in der Antwort");
  return first.hash;
}

export async function createCreative(args: {
  name: string;
  pageId: string;
  imageHash: string;
  message: string;
  headline: string;
  link: string;
  callToActionType?: string;
}): Promise<{ id: string }> {
  return graphRequest("POST", `${actId()}/adcreatives`, {
    name: args.name,
    object_story_spec: JSON.stringify({
      page_id: args.pageId,
      link_data: {
        image_hash: args.imageHash,
        link: args.link,
        message: args.message,
        name: args.headline,
        call_to_action: { type: args.callToActionType ?? "LEARN_MORE" },
      },
    }),
  });
}

export async function createAd(args: {
  name: string;
  adsetId: string;
  creativeId: string;
}): Promise<{ id: string }> {
  return graphRequest("POST", `${actId()}/ads`, {
    name: args.name,
    adset_id: args.adsetId,
    creative: JSON.stringify({ creative_id: args.creativeId }),
    status: "PAUSED",
  });
}

// Insights read, always filtered to OUR campaign_id (SPEC §5).
export async function getInsights(campaignId: string): Promise<unknown[]> {
  const result = await graphRequest<{ data: unknown[] }>("GET", `${actId()}/insights`, {
    level: "ad",
    fields: "ad_id,ad_name,campaign_id,spend,impressions,clicks,actions,cost_per_action_type",
    filtering: JSON.stringify([
      { field: "campaign.id", operator: "IN", value: [campaignId] },
    ]),
    date_preset: "maximum",
  });
  return result.data ?? [];
}
