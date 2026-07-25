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
  const json = (await res.json()) as T & {
    error?: { message?: string; type?: string; code?: number; error_user_msg?: string };
  };
  if (!res.ok || json.error) {
    // Only the Graph error message — never the token or full request.
    const detail = json.error?.error_user_msg ? ` — ${json.error.error_user_msg}` : "";
    throw new Error(
      `Meta Graph ${method} /${path} fehlgeschlagen: ${json.error?.message ?? res.status} (code ${json.error?.code ?? res.status})${detail}`,
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
    // v25 requires an explicit bid strategy on CBO create
    // (pre-flight-verified 2026-07-25, SPEC §5).
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
  });
}

// Standard conversion events Meta accepts directly as custom_event_type;
// anything else goes through OTHER + custom_event_str.
const STANDARD_EVENTS = new Set([
  "LEAD",
  "PURCHASE",
  "COMPLETE_REGISTRATION",
  "CONTACT",
  "SUBSCRIBE",
  "SUBMIT_APPLICATION",
]);

export async function createAdSet(args: {
  name: string;
  campaignId: string;
  geoCountries: string[];
  optimizationGoal: string;
  billingEvent: string;
  // EU DSA (verified against the live account): without dsa_beneficiary the
  // create fails with subcode 3858081 for EU-targeted ad sets.
  dsaBeneficiary: string;
  dsaPayor?: string;
  // Without a pixel the caller falls back to LINK_CLICKS and omits this.
  promotedObject?: { pixelId: string; leadEventName: string };
}): Promise<{ id: string }> {
  const params: Record<string, string> = {
    name: args.name,
    campaign_id: args.campaignId,
    status: "PAUSED",
    optimization_goal: args.optimizationGoal,
    billing_event: args.billingEvent,
    targeting: JSON.stringify({ geo_locations: { countries: args.geoCountries } }),
    dsa_beneficiary: args.dsaBeneficiary,
    dsa_payor: args.dsaPayor ?? args.dsaBeneficiary,
  };
  if (args.promotedObject) {
    const event = args.promotedObject.leadEventName.toUpperCase();
    params.promoted_object = JSON.stringify(
      STANDARD_EVENTS.has(event)
        ? { pixel_id: args.promotedObject.pixelId, custom_event_type: event }
        : {
            pixel_id: args.promotedObject.pixelId,
            custom_event_type: "OTHER",
            custom_event_str: args.promotedObject.leadEventName,
          },
    );
  }
  return graphRequest("POST", `${actId()}/adsets`, params);
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

// Dynamic URL tags for attribution ({{campaign.id}} etc. are Meta macros,
// resolved by Meta at delivery time — sent literally as one string).
export const DEFAULT_URL_TAGS =
  "utm_source=adloop&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{ad.id}}";

export async function createCreative(args: {
  name: string;
  pageId: string;
  imageHash: string;
  message: string;
  headline: string;
  link: string;
  callToActionType?: string;
  urlTags?: string;
}): Promise<{ id: string }> {
  return graphRequest("POST", `${actId()}/adcreatives`, {
    name: args.name,
    url_tags: args.urlTags ?? DEFAULT_URL_TAGS,
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

// Raw Graph insights row: numbers arrive as strings, actions as a list of
// { action_type, value } pairs. Normalization happens in the Analyst.
export interface MetaInsightRow {
  ad_id?: string;
  ad_name?: string;
  campaign_id?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: { action_type?: string; value?: string }[];
  cost_per_action_type?: { action_type?: string; value?: string }[];
}

// Insights read, always filtered to OUR campaign_id (SPEC §5).
export async function getInsights(campaignId: string): Promise<MetaInsightRow[]> {
  const result = await graphRequest<{ data: MetaInsightRow[] }>("GET", `${actId()}/insights`, {
    level: "ad",
    fields: "ad_id,ad_name,campaign_id,spend,impressions,clicks,actions,cost_per_action_type",
    filtering: JSON.stringify([
      { field: "campaign.id", operator: "IN", value: [campaignId] },
    ]),
    date_preset: "maximum",
  });
  return result.data ?? [];
}
