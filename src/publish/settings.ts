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

export const AttributionClickSchema = z.enum(["1d_click", "7d_click", "28d_click"]);
export const AttributionViewSchema = z.enum(["1d_view", "7d_view", "28d_view", "none"]);
export const AttributionEngagedSchema = z.enum(["1d_engaged", "none"]);

/**
 * Labels allowed on metric_optimization_binding.attribution_spec.
 * Rejected at save time — never silently dropped at publish.
 */
export const BindingAttributionLabelSchema = z.enum([
  "1d_view",
  "7d_view",
  "28d_view",
  "1d_click",
  "7d_click",
  "28d_click",
  "1d_engaged",
]);

export const BindingAttributionSpecSchema = z
  .array(BindingAttributionLabelSchema)
  .min(1);

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
  return bindingAttributionToMetaSpec(attributionToLabels(attribution));
}

/** Labels as stored on conversion metrics / bindings (e.g. 1d_click). */
export function attributionToLabels(
  attribution: AdvertiserDefaults["adSet"]["attribution"],
): string[] {
  const labels: string[] = [];
  labels.push(attribution.click);
  if (attribution.view !== "none") labels.push(attribution.view);
  if (attribution.engaged !== "none") labels.push(attribution.engaged);
  return labels.sort();
}

/**
 * Binding attribution_spec → Meta create payload. Binding wins over defaults.
 */
export function bindingAttributionToMetaSpec(
  labels: readonly string[],
): Array<{ event_type: string; window_days: number }> {
  const spec: Array<{ event_type: string; window_days: number }> = [];
  for (const label of labels) {
    const parsed = BindingAttributionLabelSchema.safeParse(label);
    if (!parsed.success) {
      throw new Error(`unknown_attribution_label:${label}`);
    }
    switch (parsed.data) {
      case "1d_click":
        spec.push({ event_type: "CLICK_THROUGH", window_days: 1 });
        break;
      case "7d_click":
        spec.push({ event_type: "CLICK_THROUGH", window_days: 7 });
        break;
      case "28d_click":
        spec.push({ event_type: "CLICK_THROUGH", window_days: 28 });
        break;
      case "1d_view":
        spec.push({ event_type: "VIEW_THROUGH", window_days: 1 });
        break;
      case "7d_view":
        spec.push({ event_type: "VIEW_THROUGH", window_days: 7 });
        break;
      case "28d_view":
        spec.push({ event_type: "VIEW_THROUGH", window_days: 28 });
        break;
      case "1d_engaged":
        spec.push({ event_type: "ENGAGED_VIDEO_VIEW", window_days: 1 });
        break;
    }
  }
  return spec;
}

export function sameLabelSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * EU/EEA country codes that require DSA beneficiary + payor on ad sets
 * (Meta error_subcode 3858081).
 */
export const DSA_REQUIRED_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
]);

export function targetingRequiresDsa(countries: readonly string[]): boolean {
  return countries.some((c) => DSA_REQUIRED_COUNTRIES.has(c.toUpperCase()));
}

/**
 * Convert a wall-clock date/time in `timeZone` to a UTC ISO string.
 * Uses Intl so DST (e.g. Europe/Berlin CEST) is applied — no fixed offset.
 */
export function wallTimeInZoneToIso(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMs = zonedOffsetMs(new Date(asUtcMs), timeZone);
  let utcMs = asUtcMs - offsetMs;
  // Re-probe in case the first guess sat across a DST transition.
  const corrected = zonedOffsetMs(new Date(utcMs), timeZone);
  utcMs = asUtcMs - corrected;
  return new Date(utcMs).toISOString();
}

function zonedOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const num = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    num("year"),
    num("month") - 1,
    num("day"),
    num("hour"),
    num("minute"),
    num("second"),
  );
  return asIfUtc - instant.getTime();
}

/** Calendar date (Y-M-D) in a timezone, plus optional day offset. */
export function zonedCalendarDate(
  now: Date,
  timeZone: string,
  offsetDays: number,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const num = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Shift in UTC midnight space so month boundaries stay correct.
  const base = Date.UTC(num("year"), num("month") - 1, num("day"));
  const shifted = new Date(base + offsetDays * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}
