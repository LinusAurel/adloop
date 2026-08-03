/**
 * What adloop needs before it can work, and how far along an installation is.
 *
 * This is a derivation, not a wizard: nothing here records that somebody
 * clicked "done". A step is done when the data says so, which means it can go
 * back to open — a disconnected Meta account or a deleted metric assignment
 * has to show up as missing again. A stored checkmark could not do that.
 *
 * Kept free of database and environment access on purpose: the rules are the
 * part worth testing, and they are testable without either.
 */

export const SETUP_STEP_IDS = [
  "meta_connection",
  "insight_sync",
  "conversion_metric",
  "advertiser_defaults",
  "image_provider",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/**
 * `blocked` means the step cannot be attempted yet, not that it is forbidden —
 * there is no ad account to sync before one is selected. Everything else is
 * `todo`, and any `todo` step may be left open for as long as the user likes.
 */
export type SetupStepStatus = "done" | "todo" | "blocked";

/** Stable identifiers (SPEC §8.2); the interface turns them into sentences. */
export type SetupReason =
  | "meta_credentials_missing"
  | "no_connection"
  | "connection_expired"
  | "no_account_selected"
  | "sync_missing"
  | "metric_unassigned"
  | "defaults_missing"
  | "provider_missing";

export interface SetupAccountFacts {
  id: string;
  name: string;
  /** At least one insight_sync_run in status `succeeded`. */
  hasSucceededSync: boolean;
  /** A row in ad_account_metric_assignment — a metric that exists but is
   * assigned nowhere leaves every number on the fallback definition. */
  hasAssignedMetric: boolean;
  /** advertiser_defaults with a non-empty identity.pageId. */
  hasPublishDefaults: boolean;
}

export interface SetupFacts {
  /** Meta app credentials in the environment. Nobody can connect without them,
   * and no button in the interface can supply them. */
  metaConfigured: boolean;
  connections: number;
  /** Connections whose token has not expired yet — an expired one cannot sync. */
  usableConnections: number;
  selectedAccounts: readonly SetupAccountFacts[];
  /** Providers that can actually produce an ad image. */
  imageProviders: readonly string[];
}

export interface SetupStep {
  id: SetupStepId;
  status: SetupStepStatus;
  /** What is in the way; `null` when the step is done. */
  reason: SetupReason | null;
  /** Names of the selected ad accounts that still miss this step. */
  pendingAccounts: readonly string[];
  /**
   * Without these, every number in the product is either absent or standing on
   * a fallback. The other two gate one surface each (Launch, Werkstatt) and are
   * not worth interrupting somebody who is doing something else.
   */
  essential: boolean;
}

const ESSENTIAL: ReadonlySet<SetupStepId> = new Set<SetupStepId>([
  "meta_connection",
  "insight_sync",
  "conversion_metric",
]);

function accountScopedStep(
  id: SetupStepId,
  accounts: readonly SetupAccountFacts[],
  satisfied: (account: SetupAccountFacts) => boolean,
  reason: SetupReason,
): SetupStep {
  const essential = ESSENTIAL.has(id);
  if (accounts.length === 0) {
    return {
      id,
      status: "blocked",
      reason: "no_account_selected",
      pendingAccounts: [],
      essential,
    };
  }
  const pending = accounts.filter((account) => !satisfied(account));
  return {
    id,
    status: pending.length === 0 ? "done" : "todo",
    reason: pending.length === 0 ? null : reason,
    pendingAccounts: pending.map((account) => account.name),
    essential,
  };
}

function metaConnectionStep(facts: SetupFacts): SetupStep {
  const base = { id: "meta_connection" as const, pendingAccounts: [], essential: true };
  // Missing credentials are not a task in this interface — they are an
  // environment the operator has to provide — so this is blocked, not todo.
  if (!facts.metaConfigured) {
    return { ...base, status: "blocked", reason: "meta_credentials_missing" };
  }
  if (facts.usableConnections === 0) {
    return {
      ...base,
      status: "todo",
      reason: facts.connections > 0 ? "connection_expired" : "no_connection",
    };
  }
  if (facts.selectedAccounts.length === 0) {
    return { ...base, status: "todo", reason: "no_account_selected" };
  }
  return { ...base, status: "done", reason: null };
}

export function deriveSetupSteps(facts: SetupFacts): SetupStep[] {
  return [
    metaConnectionStep(facts),
    accountScopedStep(
      "insight_sync",
      facts.selectedAccounts,
      (account) => account.hasSucceededSync,
      "sync_missing",
    ),
    accountScopedStep(
      "conversion_metric",
      facts.selectedAccounts,
      (account) => account.hasAssignedMetric,
      "metric_unassigned",
    ),
    accountScopedStep(
      "advertiser_defaults",
      facts.selectedAccounts,
      (account) => account.hasPublishDefaults,
      "defaults_missing",
    ),
    {
      id: "image_provider",
      // Independent of Meta: an image provider can be configured before a single
      // account exists, so it is never blocked by anything above it.
      status: facts.imageProviders.length > 0 ? "done" : "todo",
      reason: facts.imageProviders.length > 0 ? null : "provider_missing",
      pendingAccounts: [],
      essential: false,
    },
  ];
}

export function completedCount(steps: readonly SetupStep[]): number {
  return steps.filter((step) => step.status === "done").length;
}

/** The steps the shell-wide hint is allowed to interrupt somebody about. */
export function openEssentialSteps(steps: readonly SetupStep[]): SetupStepId[] {
  return steps
    .filter((step) => step.essential && step.status !== "done")
    .map((step) => step.id);
}
