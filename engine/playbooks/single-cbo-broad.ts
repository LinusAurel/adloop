// Playbook „Single CBO broad“: exactly ONE campaign (OUTCOME_LEADS, CBO,
// LOWEST_COST_WITHOUT_CAP) with ONE broad ad set. The whole campaign
// structure lives in this module — post-hackathon, further playbooks
// (test+scale ABO etc.) plug in as sibling modules with the same contract.
// Idempotent: existing IDs on the brand are reused, never re-created.

import { createAdSet, createCampaign } from "../connectors/meta.ts";
import { buildAdSetName, buildCampaignName } from "../naming.ts";
import type { Brand } from "../types.ts";

export interface StructureResult {
  campaignId: string;
  adsetId: string;
  createdCampaign: boolean;
  createdAdSet: boolean;
  notes: string[];
}

export async function ensureSingleCboBroad(brand: Brand): Promise<StructureResult> {
  const notes: string[] = [];
  const budget = brand.meta.fixedDailyBudgetCents;
  if (typeof budget !== "number" || budget <= 0) {
    // Hard Stop 4: the budget is set by a human upfront; code never invents one.
    throw new Error(
      `fixedDailyBudgetCents fehlt in brands/${brand.slug}/brand.json — Budget setzt ein Mensch, nicht der Code`,
    );
  }

  let campaignId = brand.meta.campaignId;
  let createdCampaign = false;
  if (!campaignId) {
    const name = buildCampaignName({ brandSlug: brand.slug });
    const res = await createCampaign({
      name,
      dailyBudgetCents: budget,
      specialAdCategories: brand.meta.specialAdCategories,
    });
    campaignId = res.id;
    createdCampaign = true;
    notes.push(`Kampagne „${name}“ angelegt (PAUSED, CBO ${budget / 100} €/Tag)`);
  } else {
    notes.push(`Kampagne existiert bereits (${campaignId}) — kein Duplikat`);
  }

  let adsetId = brand.meta.adsetId;
  let createdAdSet = false;
  if (!adsetId) {
    const geo = brand.meta.geoCountries[0] ?? "DE";
    const name = buildAdSetName({ brandSlug: brand.slug, geo });
    const hasPixel = brand.meta.pixelId.trim() !== "";
    const res = await createAdSet({
      name,
      campaignId,
      geoCountries: brand.meta.geoCountries,
      // Without a pixel, OFFSITE_CONVERSIONS is not creatable -> fallback.
      optimizationGoal: hasPixel ? brand.meta.optimizationGoal : "LINK_CLICKS",
      billingEvent: brand.meta.billingEvent,
      promotedObject: hasPixel
        ? { pixelId: brand.meta.pixelId, leadEventName: brand.meta.leadEventName }
        : undefined,
    });
    adsetId = res.id;
    createdAdSet = true;
    notes.push(`AdSet „${name}“ angelegt (PAUSED, geo ${brand.meta.geoCountries.join(",")})`);
    if (!hasPixel) {
      notes.push(
        "TODO: keine Pixel-ID in brand.json — AdSet läuft als LINK_CLICKS-Fallback; nach Pixel-Setup auf OFFSITE_CONVERSIONS umstellen",
      );
    }
  } else {
    notes.push(`AdSet existiert bereits (${adsetId}) — kein Duplikat`);
  }

  return { campaignId, adsetId, createdCampaign, createdAdSet, notes };
}
