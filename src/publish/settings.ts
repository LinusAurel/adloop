import { z } from "zod";

/** Meta optimization goals we accept in defaults / bindings. */
export const OptimizationGoalSchema = z.enum([
  "OFFSITE_CONVERSIONS",
  "LEAD_GENERATION",
  "LINK_CLICKS",
  "LANDING_PAGE_VIEWS",
  "IMPRESSIONS",
  "REACH",
  "VALUE",
  "CONVERSATIONS",
]);

export const BillingEventSchema = z.enum(["IMPRESSIONS", "LINK_CLICKS"]);

export const BidStrategySchema = z.enum([
  "LOWEST_COST_WITHOUT_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_BID_CAP",
]);

export const BudgetModeSchema = z.enum(["CBO", "ABO"]);

export const CallToActionSchema = z.enum([
  "SHOP_NOW",
  "LEARN_MORE",
  "SIGN_UP",
  "APPLY_NOW",
  "SUBSCRIBE",
  "DOWNLOAD",
  "GET_OFFER",
  "GET_QUOTE",
  "CONTACT_US",
  "ORDER_NOW",
  "BOOK_NOW",
  "BUY_NOW",
  "WATCH_MORE",
]);

export const CampaignObjectiveSchema = z.enum([
  "OUTCOME_TRAFFIC",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_AWARENESS",
]);

export const AttributionClickSchema = z.enum(["1d_click", "7d_click"]);
export const AttributionViewSchema = z.enum(["1d_view", "none"]);
export const AttributionEngagedSchema = z.enum(["1d_engaged", "none"]);

export const AdvantageCreativeTogglesSchema = z.object({
  advantagePlusCreative: z.boolean().default(false),
  visualTouchUps: z.boolean().default(false),
  textImprovements: z.boolean().default(false),
  addOverlays: z.boolean().default(false),
  musicOverlay: z.boolean().default(false),
  imageAnimation: z.boolean().default(false),
  generateBackgrounds: z.boolean().default(false),
  enhanceCta: z.boolean().default(false),
  translateText: z.boolean().default(false),
  profileAndCard: z.boolean().default(false),
  dynamicDescription: z.boolean().default(false),
});

/**
 * Schematized advertiser defaults — validated against Meta enums on save,
 * not at publish time.
 */
export const AdvertiserDefaultsSchema = z.object({
  identity: z.object({
    pageId: z.string().min(1),
    instagramActorId: z.string().min(1).optional(),
    /** EU DSA — required when targeting EU countries (DACH). */
    beneficiaryName: z.string().min(1).optional(),
    payerName: z.string().min(1).optional(),
  }),
  adSet: z.object({
    optimizationGoal: OptimizationGoalSchema,
    billingEvent: BillingEventSchema.default("IMPRESSIONS"),
    placements: z
      .object({
        advantagePlus: z.boolean().default(true),
        facebook: z.boolean().default(true),
        instagram: z.boolean().default(true),
        audienceNetwork: z.boolean().default(false),
        messenger: z.boolean().default(false),
      })
      .default({}),
    targeting: z.object({
      countries: z.array(z.string().length(2)).min(1),
      ageMin: z.number().int().min(13).max(65).default(18),
      ageMax: z.number().int().min(13).max(65).default(65),
      genders: z.array(z.union([z.literal(1), z.literal(2)])).default([]),
    }),
    audiences: z
      .object({
        advantagePlusEnabled: z.boolean().default(true),
        includedCustomAudienceIds: z.array(z.string()).default([]),
        excludedCustomAudienceIds: z.array(z.string()).default([]),
      })
      .default({}),
    schedule: z
      .object({
        timezone: z.string().min(1).default("Europe/Berlin"),
        offsetDays: z.number().int().min(0).max(30).default(1),
        time: z.string().regex(/^\d{2}:\d{2}$/).default("00:00"),
      })
      .default({}),
    attribution: z
      .object({
        click: AttributionClickSchema.default("7d_click"),
        view: AttributionViewSchema.default("1d_view"),
        engaged: AttributionEngagedSchema.default("none"),
      })
      .default({}),
    bidStrategy: BidStrategySchema.default("LOWEST_COST_WITHOUT_CAP"),
    bidAmount: z.number().int().positive().optional(),
    budgetMode: BudgetModeSchema.default("ABO"),
  }),
  creative: z
    .object({
      image: AdvantageCreativeTogglesSchema.default({}),
      video: AdvantageCreativeTogglesSchema.default({}),
      carousel: AdvantageCreativeTogglesSchema.default({}),
    })
    .default({}),
  website: z.object({
    url: z.string().url(),
    utmParams: z.string().default(""),
  }),
  autoNaming: z.object({
    creativeTemplate: z.string().min(1).default("{advertiser} / {date}"),
    adSetTemplate: z.string().min(1).default("{advertiser} / {optimization}"),
    adTemplate: z.string().min(1).default("{creative} / {date}"),
  }),
  defaultAdCopy: z
    .object({
      primaryTexts: z.array(z.string()).default([]),
      headlines: z.array(z.string()).default([]),
      descriptions: z.array(z.string()).default([]),
      callToAction: CallToActionSchema.default("LEARN_MORE"),
    })
    .default({}),
  campaignObjective: CampaignObjectiveSchema.default("OUTCOME_TRAFFIC"),
});

export type AdvertiserDefaults = z.infer<typeof AdvertiserDefaultsSchema>;

export const PromotedObjectSchema = z.union([
  z.object({
    pixel_id: z.string().min(1),
    custom_event_type: z.string().min(1),
  }),
  z.object({
    page_id: z.string().min(1),
  }),
  z.object({
    pixel_id: z.string().min(1),
    custom_event_str: z.string().min(1),
  }),
]);

export type PromotedObject = z.infer<typeof PromotedObjectSchema>;

export function attributionToMetaSpec(
  attribution: AdvertiserDefaults["adSet"]["attribution"],
): Array<{ event_type: string; window_days: number }> {
  const spec: Array<{ event_type: string; window_days: number }> = [];
  if (attribution.click === "7d_click") {
    spec.push({ event_type: "CLICK_THROUGH", window_days: 7 });
  } else {
    spec.push({ event_type: "CLICK_THROUGH", window_days: 1 });
  }
  if (attribution.view === "1d_view") {
    spec.push({ event_type: "VIEW_THROUGH", window_days: 1 });
  }
  if (attribution.engaged === "1d_engaged") {
    spec.push({ event_type: "ENGAGED_VIDEO_VIEW", window_days: 1 });
  }
  return spec;
}
