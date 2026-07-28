import { PublishError, type BudgetSource } from "./schemas";

export type BudgetMode = "CBO" | "ABO";

export type BudgetPlacement =
  | { level: "campaign"; required: true }
  | { level: "adset"; required: true }
  | { level: "none"; required: false };

/**
 * CBO matrix (auftrag §0.2). A budget at the wrong level is an error, not a
 * default.
 *
 * | Campaign     | Ad Set     | Budget                         |
 * |--------------|------------|--------------------------------|
 * | new, ABO     | new        | Ad Set, required               |
 * | new, CBO     | new        | Campaign, required; no ad set  |
 * | existing,CBO | new        | none (campaign budget applies) |
 * | existing,ABO | new        | Ad Set, required               |
 * | existing     | existing   | none                           |
 */
export function resolveBudgetPlacement(params: {
  campaignMode: "new" | "existing";
  adSetMode: "new" | "existing";
  budgetMode: BudgetMode;
  /** For existing campaigns: whether the campaign is CBO. */
  existingCampaignIsCbo?: boolean;
}): BudgetPlacement {
  if (params.campaignMode === "existing" && params.adSetMode === "existing") {
    return { level: "none", required: false };
  }

  if (params.campaignMode === "existing" && params.adSetMode === "new") {
    const isCbo = params.existingCampaignIsCbo ?? params.budgetMode === "CBO";
    if (isCbo) return { level: "none", required: false };
    return { level: "adset", required: true };
  }

  if (params.campaignMode === "new" && params.adSetMode === "new") {
    if (params.budgetMode === "CBO") {
      return { level: "campaign", required: true };
    }
    return { level: "adset", required: true };
  }

  // new campaign + existing ad set is not a valid Meta structure
  throw new PublishError("validation_error", { reason: "invalid_campaign_adset_combo" });
}

export function requireBudgetSource(params: {
  placement: BudgetPlacement;
  humanBudget: { amount: number; currency: string } | undefined;
  decidedBy: string;
  decidedAt: string;
}): BudgetSource | undefined {
  if (!params.placement.required) {
    if (params.humanBudget) {
      throw new PublishError("budget_wrong_level", {
        level: params.placement.level,
        reason: "budget_not_needed",
      });
    }
    return undefined;
  }

  if (!params.humanBudget) {
    throw new PublishError("budget_required", {
      level: params.placement.level,
    });
  }

  return {
    kind: "human_input",
    decidedBy: params.decidedBy,
    decidedAt: params.decidedAt,
    amount: params.humanBudget.amount,
    currency: params.humanBudget.currency,
    level: params.placement.level,
  };
}
