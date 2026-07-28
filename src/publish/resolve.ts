import type { Queryable } from "@/db/queryable";
import { uuidv7 } from "uuidv7";
import {
  AdvertiserDefaultsSchema,
  attributionToLabels,
  bindingAttributionToMetaSpec,
  sameLabelSet,
  targetingRequiresDsa,
  wallTimeInZoneToIso,
  zonedCalendarDate,
  type AdvertiserDefaults,
} from "./settings";
import {
  requireBudgetSource,
  resolveBudgetPlacement,
  type BudgetMode,
} from "./budget";
import {
  PublishError,
  type PublishAgentInput,
  type PublishHumanInput,
  type ResolvedPublishPayload,
  META_PUBLISH_STATUS,
} from "./schemas";
import { applyUtmParams, expandNamingTemplate, formatCorrelatedName } from "./utm";
import { PromotedObjectSchema } from "./settings";
import { publishNow } from "./fault";

export interface BindingRow {
  id: string;
  version: number;
  conversion_metric_id: string;
  conversion_metric_version: number;
  optimization_goal: string;
  promoted_object: unknown;
  attribution_spec: string[];
}

/** Reads campaign budget fields from Meta (or a mock) for the CBO matrix. */
export type CampaignBudgetReader = {
  getCampaign(campaignId: string): Promise<{
    dailyBudget: number | null;
    lifetimeBudget: number | null;
  }>;
};

export function campaignIsCbo(budgets: {
  dailyBudget: number | null;
  lifetimeBudget: number | null;
}): boolean {
  return budgets.dailyBudget != null || budgets.lifetimeBudget != null;
}

export async function loadLatestDefaults(
  db: Queryable,
  tenantId: string,
  advertiserId: string,
): Promise<{ version: number; settings: AdvertiserDefaults } | null> {
  const result = await db.query<{ version: number; settings: unknown }>(
    `SELECT version, settings
     FROM advertiser_defaults
     WHERE tenant_id = $1 AND advertiser_id = $2
     ORDER BY version DESC
     LIMIT 1`,
    [tenantId, advertiserId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const parsed = AdvertiserDefaultsSchema.safeParse(row.settings);
  if (!parsed.success) {
    throw new PublishError("validation_error", { reason: "defaults_corrupt" });
  }
  return { version: row.version, settings: parsed.data };
}

export async function saveDefaults(
  db: Queryable,
  params: {
    tenantId: string;
    advertiserId: string;
    settings: AdvertiserDefaults;
    createdBy: string;
  },
): Promise<{ version: number; id: string }> {
  const parsed = AdvertiserDefaultsSchema.parse(params.settings);
  const previous = await loadLatestDefaults(
    db,
    params.tenantId,
    params.advertiserId,
  );
  // Preserve DSA identity fields when the incoming payload omits them
  // (UI that does not know the fields must not wipe API-set values).
  const merged: AdvertiserDefaults = {
    ...parsed,
    identity: {
      ...parsed.identity,
      beneficiaryName:
        parsed.identity.beneficiaryName ??
        previous?.settings.identity.beneficiaryName,
      payerName:
        parsed.identity.payerName ?? previous?.settings.identity.payerName,
    },
  };
  const version = (previous?.version ?? 0) + 1;
  const id = uuidv7();
  await db.query(
    `INSERT INTO advertiser_defaults (
       id, tenant_id, advertiser_id, version, settings, created_by
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      id,
      params.tenantId,
      params.advertiserId,
      version,
      JSON.stringify(merged),
      params.createdBy,
    ],
  );
  return { version, id };
}

export async function loadActiveBinding(
  db: Queryable,
  tenantId: string,
  conversionMetricId: string,
): Promise<BindingRow | null> {
  const result = await db.query<BindingRow>(
    `SELECT id, version, conversion_metric_id, conversion_metric_version,
            optimization_goal, promoted_object, attribution_spec
     FROM metric_optimization_binding
     WHERE tenant_id = $1 AND conversion_metric_id = $2 AND active = true
     LIMIT 1`,
    [tenantId, conversionMetricId],
  );
  return result.rows[0] ?? null;
}

export async function resolveAssignedMetricId(
  db: Queryable,
  tenantId: string,
  metaAdAccountId: string,
): Promise<{ id: string; version: number } | null> {
  const result = await db.query<{ id: string; version: number }>(
    `SELECT cm.id, cm.version
     FROM ad_account_metric_assignment a
     JOIN conversion_metric cm
       ON cm.id = a.conversion_metric_id
      AND cm.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1
       AND a.meta_ad_account_id = $2
       AND a.effective_from <= now()
       AND (a.effective_to IS NULL OR a.effective_to > now())
       AND cm.effective_from <= now()
       AND (cm.effective_to IS NULL OR cm.effective_to > now())
     ORDER BY cm.version DESC
     LIMIT 1`,
    [tenantId, metaAdAccountId],
  );
  return result.rows[0] ?? null;
}

function scheduleStartTime(
  defaults: AdvertiserDefaults,
  accountTimezone: string,
): string {
  const offset = defaults.adSet.schedule.offsetDays;
  const [hh, mm] = defaults.adSet.schedule.time.split(":").map(Number);
  // Prefer the Meta ad account timezone (source of truth for delivery).
  const timeZone = accountTimezone || defaults.adSet.schedule.timezone;
  const cal = zonedCalendarDate(publishNow(), timeZone, offset);
  return wallTimeInZoneToIso(
    timeZone,
    cal.year,
    cal.month,
    cal.day,
    hh ?? 0,
    mm ?? 0,
  );
}

function buildTargeting(defaults: AdvertiserDefaults): Record<string, unknown> {
  const targeting: Record<string, unknown> = {
    geo_locations: {
      countries: defaults.adSet.targeting.countries,
    },
    age_min: defaults.adSet.targeting.ageMin,
    age_max: defaults.adSet.targeting.ageMax,
  };
  if (defaults.adSet.targeting.genders.length > 0) {
    targeting.genders = defaults.adSet.targeting.genders;
  }
  if (defaults.adSet.audiences.excludedCustomAudienceIds.length > 0) {
    targeting.excluded_custom_audiences =
      defaults.adSet.audiences.excludedCustomAudienceIds.map((id) => ({ id }));
  }
  if (defaults.adSet.audiences.includedCustomAudienceIds.length > 0) {
    targeting.custom_audiences =
      defaults.adSet.audiences.includedCustomAudienceIds.map((id) => ({ id }));
  }
  return targeting;
}

/**
 * Resolve human Launch input into the sealed payload that Freigabe hashes.
 * Agent-only input without budget fails with budget_required when the CBO
 * matrix requires one.
 */
export async function resolvePublishPayload(
  db: Queryable,
  params: {
    tenantId: string;
    userId: string;
    input: PublishHumanInput | PublishAgentInput;
    /** True when budget may come from the human form. */
    allowHumanBudget: boolean;
    /**
     * Required when campaign.mode === "existing": reads daily/lifetime budget
     * from Meta so the CBO matrix is not guessed from defaults.
     */
    campaignReader?: CampaignBudgetReader;
  },
): Promise<ResolvedPublishPayload> {
  const input = params.input;
  const humanBudget =
    params.allowHumanBudget && "budget" in input ? input.budget : undefined;

  const account = await db.query<{
    id: string;
    meta_ad_account_id: string;
    advertiser_id: string;
    currency: string | null;
    timezone_name: string;
  }>(
    `SELECT id, meta_ad_account_id, advertiser_id, currency, timezone_name
     FROM meta_ad_account
     WHERE id = $1 AND tenant_id = $2`,
    [input.metaAdAccountId, params.tenantId],
  );
  const accountRow = account.rows[0];
  if (!accountRow || accountRow.advertiser_id !== input.advertiserId) {
    throw new PublishError("account_not_found");
  }

  const defaultsRow = await loadLatestDefaults(
    db,
    params.tenantId,
    input.advertiserId,
  );
  if (!defaultsRow) throw new PublishError("defaults_missing");
  const defaults = defaultsRow.settings;

  let existingCampaignIsCbo: boolean | undefined;
  let budgetMode: BudgetMode =
    input.campaign.mode === "new"
      ? (input.campaign.budgetMode ?? defaults.adSet.budgetMode)
      : defaults.adSet.budgetMode;

  if (input.campaign.mode === "existing") {
    if (!params.campaignReader) {
      throw new PublishError("validation_error", {
        reason: "campaign_reader_required",
      });
    }
    let budgets: { dailyBudget: number | null; lifetimeBudget: number | null };
    try {
      budgets = await params.campaignReader.getCampaign(
        input.campaign.existingCampaignId,
      );
    } catch {
      throw new PublishError("campaign_not_found");
    }
    existingCampaignIsCbo = campaignIsCbo(budgets);
    budgetMode = existingCampaignIsCbo ? "CBO" : "ABO";
  }

  const placement = resolveBudgetPlacement({
    campaignMode: input.campaign.mode,
    adSetMode: input.adSet.mode,
    budgetMode,
    existingCampaignIsCbo,
  });

  const budgetSource = requireBudgetSource({
    placement,
    humanBudget: humanBudget
      ? {
          amount: humanBudget.amount,
          currency: humanBudget.currency ?? accountRow.currency ?? "EUR",
        }
      : undefined,
    decidedBy: params.userId,
    decidedAt: new Date().toISOString(),
  });

  const metric = await resolveAssignedMetricId(
    db,
    params.tenantId,
    input.metaAdAccountId,
  );
  let binding: ResolvedPublishPayload["binding"] = null;
  let bindingMismatch = false;

  if (input.adSet.mode === "new") {
    if (!metric) {
      throw new PublishError("metric_binding_missing", { reason: "no_metric" });
    }
    const active = await loadActiveBinding(db, params.tenantId, metric.id);
    if (!active) {
      throw new PublishError("metric_binding_missing");
    }
    // Bindings pin a metric version — must match the assigned version in publish.
    if (active.conversion_metric_version !== metric.version) {
      throw new PublishError("metric_binding_missing", {
        reason: "version_mismatch",
        bindingVersion: active.conversion_metric_version,
        metricVersion: metric.version,
      });
    }
    const promoted = PromotedObjectSchema.parse(active.promoted_object);
    binding = {
      id: active.id,
      version: active.version,
      conversionMetricId: active.conversion_metric_id,
      conversionMetricVersion: active.conversion_metric_version,
      optimizationGoal: active.optimization_goal,
      promotedObject: promoted,
      attributionSpec: active.attribution_spec,
    };

    const effectiveGoal = defaults.adSet.optimizationGoal;
    const defaultsAttribution = attributionToLabels(defaults.adSet.attribution);
    const attributionDiverges = !sameLabelSet(
      defaultsAttribution,
      active.attribution_spec,
    );
    if (effectiveGoal !== active.optimization_goal || attributionDiverges) {
      bindingMismatch = true;
      if (!input.deviationReason) {
        throw new PublishError("metric_binding_mismatch", {
          measured: active.optimization_goal,
          optimizing: effectiveGoal,
          ...(attributionDiverges
            ? { reason: "attribution_mismatch" }
            : {}),
        });
      }
    }
  }

  // EU targeting requires DSA beneficiary + payor before any Meta create.
  if (
    input.adSet.mode === "new" &&
    targetingRequiresDsa(defaults.adSet.targeting.countries)
  ) {
    if (
      !defaults.identity.beneficiaryName?.trim() ||
      !defaults.identity.payerName?.trim()
    ) {
      throw new PublishError("dsa_details_required");
    }
  }

  const creatives = await db.query<{
    id: string;
    name: string;
    primary_text: string;
    headline: string;
    description: string;
    call_to_action: string;
    storage_key: string;
    mime: string;
  }>(
    `SELECT c.id, c.name, c.primary_text, c.headline, c.description,
            c.call_to_action, a.storage_key, a.mime
     FROM creative c
     JOIN asset a ON a.id = c.asset_id
     WHERE c.tenant_id = $1
       AND c.advertiser_id = $2
       AND c.id = ANY($3::uuid[])
       AND c.status = 'ready'`,
    [params.tenantId, input.advertiserId, input.creativeIds],
  );
  if (creatives.rowCount !== input.creativeIds.length) {
    throw new PublishError("creative_not_found");
  }

  const dateToken = new Date().toISOString().slice(0, 10);
  const advertiser = await db.query<{ name: string }>(
    `SELECT name FROM advertiser WHERE id = $1 AND tenant_id = $2`,
    [input.advertiserId, params.tenantId],
  );
  const advertiserName = advertiser.rows[0]?.name ?? "advertiser";

  const linkUrl = applyUtmParams(defaults.website.url, defaults.website.utmParams);

  const resolvedCreatives = creatives.rows.map((row) => {
    const creativeName = expandNamingTemplate(defaults.autoNaming.creativeTemplate, {
      advertiser: advertiserName,
      date: dateToken,
      creative: row.name,
      optimization: defaults.adSet.optimizationGoal,
    });
    const adName = expandNamingTemplate(defaults.autoNaming.adTemplate, {
      advertiser: advertiserName,
      date: dateToken,
      creative: row.name,
      optimization: defaults.adSet.optimizationGoal,
    });
    return {
      creativeId: row.id,
      name: creativeName,
      adName,
      primaryText: row.primary_text,
      headline: row.headline,
      description: row.description,
      callToAction: row.call_to_action,
      pageId: defaults.identity.pageId,
      instagramActorId: defaults.identity.instagramActorId,
      linkUrl,
      storageKey: row.storage_key,
      mime: row.mime,
    };
  });

  const campaignNameBase =
    input.campaign.mode === "new"
      ? (input.campaign.name ??
        expandNamingTemplate("{advertiser} / {date}", {
          advertiser: advertiserName,
          date: dateToken,
        }))
      : "";

  const adSetNameBase =
    input.adSet.mode === "new"
      ? (input.adSet.name ??
        expandNamingTemplate(defaults.autoNaming.adSetTemplate, {
          advertiser: advertiserName,
          date: dateToken,
          optimization: defaults.adSet.optimizationGoal,
        }))
      : "";

  const objective =
    input.campaign.mode === "new"
      ? (input.campaign.objective ?? defaults.campaignObjective)
      : defaults.campaignObjective;

  // Binding attribution wins — defaults only apply when there is no binding.
  const attributionSpec =
    binding !== null
      ? bindingAttributionToMetaSpec(binding.attributionSpec)
      : bindingAttributionToMetaSpec(
          attributionToLabels(defaults.adSet.attribution),
        );

  const payload: ResolvedPublishPayload = {
    advertiserId: input.advertiserId,
    metaAdAccountId: input.metaAdAccountId,
    metaAdAccountExternalId: accountRow.meta_ad_account_id,
    creativeIds: input.creativeIds,
    campaign:
      input.campaign.mode === "existing"
        ? {
            mode: "existing",
            existingCampaignId: input.campaign.existingCampaignId,
          }
        : {
            mode: "new",
            name: campaignNameBase,
            objective,
            budgetMode,
            isAdsetBudgetSharingEnabled: budgetMode === "CBO",
          },
    adSet:
      input.adSet.mode === "existing"
        ? {
            mode: "existing",
            existingAdSetId: input.adSet.existingAdSetId,
          }
        : {
            mode: "new",
            name: adSetNameBase,
            optimizationGoal: defaults.adSet.optimizationGoal,
            billingEvent: defaults.adSet.billingEvent,
            bidStrategy: defaults.adSet.bidStrategy,
            bidAmount: defaults.adSet.bidAmount,
            targeting: buildTargeting(defaults),
            attributionSpec,
            promotedObject: binding?.promotedObject,
            startTime: scheduleStartTime(defaults, accountRow.timezone_name),
            dsaBeneficiary: defaults.identity.beneficiaryName,
            dsaPayor: defaults.identity.payerName,
          },
    creatives: resolvedCreatives,
    budgetSource,
    budgetMode,
    binding,
    deviationReason: input.deviationReason,
    bindingMismatch,
    idempotencyKey: input.idempotencyKey,
    status: META_PUBLISH_STATUS,
  };

  // Names get correlation stamps later when steps are created — base names stay here.
  void formatCorrelatedName;
  return payload;
}
