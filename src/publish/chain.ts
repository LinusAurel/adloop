import { uuidv7 } from "uuidv7";
import type { Queryable } from "@/db/queryable";
import { sha256Canonical } from "@/lib/canonical-json";
import type { MetaWriteClient } from "@/meta/write-client";
import type { ObjectStore } from "@/storage/object-store";
import {
  META_PUBLISH_STATUS,
  PublishError,
  type PublishStepOperation,
  type ResolvedPublishPayload,
} from "./schemas";
import { formatCorrelatedName } from "./utm";
import {
  maybeCrashAfterPersist,
  publishNow,
} from "./fault";

export const DEFAULT_STEP_LEASE_MS = 120_000;

export type WriteClient = Pick<
  MetaWriteClient,
  | "createCampaign"
  | "createAdSet"
  | "uploadAdImage"
  | "createAdCreative"
  | "createAd"
  | "getObjectStatus"
  | "searchByName"
  | "deleteObject"
>;

interface StepRow {
  id: string;
  publication_id: string;
  step_index: number;
  operation: PublishStepOperation;
  request_hash: string;
  status: "pending" | "in_flight" | "succeeded" | "failed";
  external_id: string | null;
  attempt: number;
  lease_expires_at: string | null;
  reconcile_state: "none" | "pending" | "resolved" | "needs_human_review";
  external_correlation: string;
  object_name: string;
  error: unknown;
}

interface PublicationRow {
  id: string;
  tenant_id: string;
  status: string;
  resolved_payload: ResolvedPublishPayload;
  deviation_reason: string | null;
}

function edgeForOperation(
  operation: PublishStepOperation,
): "campaigns" | "adsets" | "ads" | "adcreatives" {
  switch (operation) {
    case "create_campaign":
      return "campaigns";
    case "create_adset":
      return "adsets";
    case "create_creative":
      return "adcreatives";
    case "create_ad":
      return "ads";
  }
}

/**
 * Create publication + steps from a sealed resolved payload. Existing
 * campaign/adset become succeeded steps with their external ids so the
 * chain stays contiguous.
 */
export async function createPublication(
  db: Queryable,
  params: {
    tenantId: string;
    runId: string;
    approvalId?: string;
    payload: ResolvedPublishPayload;
  },
): Promise<{ publicationId: string }> {
  if (params.payload.status !== META_PUBLISH_STATUS) {
    throw new PublishError("validation_error", { reason: "status_must_be_paused" });
  }

  const existing = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM publication
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [params.tenantId, params.payload.idempotencyKey],
  );
  if (existing.rows[0]) {
    if (
      existing.rows[0].status === "succeeded" ||
      existing.rows[0].status === "pending" ||
      existing.rows[0].status === "in_progress" ||
      existing.rows[0].status === "failed"
    ) {
      return { publicationId: existing.rows[0].id };
    }
    if (existing.rows[0].status === "needs_human_review") {
      return { publicationId: existing.rows[0].id };
    }
    throw new PublishError("idempotency_conflict");
  }

  const publicationId = uuidv7();
  await db.query(
    `INSERT INTO publication (
       id, tenant_id, advertiser_id, meta_ad_account_id, run_id,
       idempotency_key, status, binding_id, binding_version,
       deviation_reason, budget_source, resolved_payload, approval_id
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, 'pending', $7, $8,
       $9, $10::jsonb, $11::jsonb, $12
     )`,
    [
      publicationId,
      params.tenantId,
      params.payload.advertiserId,
      params.payload.metaAdAccountId,
      params.runId,
      params.payload.idempotencyKey,
      params.payload.binding?.id ?? null,
      params.payload.binding?.version ?? null,
      params.payload.deviationReason ?? null,
      params.payload.budgetSource
        ? JSON.stringify(params.payload.budgetSource)
        : null,
      JSON.stringify(params.payload),
      params.approvalId ?? null,
    ],
  );

  const steps: Array<{
    operation: PublishStepOperation;
    correlation: string;
    name: string;
    requestHash: string;
    status: "pending" | "succeeded";
    externalId: string | null;
  }> = [];

  if (params.payload.campaign.mode === "existing") {
    const correlation = uuidv7();
    steps.push({
      operation: "create_campaign",
      correlation,
      name: `existing:${params.payload.campaign.existingCampaignId}`,
      requestHash: sha256Canonical({
        op: "create_campaign",
        existing: params.payload.campaign.existingCampaignId,
      }),
      status: "succeeded",
      externalId: params.payload.campaign.existingCampaignId,
    });
  } else {
    const correlation = uuidv7();
    const name = formatCorrelatedName(params.payload.campaign.name, correlation);
    steps.push({
      operation: "create_campaign",
      correlation,
      name,
      requestHash: sha256Canonical({
        op: "create_campaign",
        name,
        objective: params.payload.campaign.objective,
        budgetMode: params.payload.campaign.budgetMode,
      }),
      status: "pending",
      externalId: null,
    });
  }

  if (params.payload.adSet.mode === "existing") {
    const correlation = uuidv7();
    steps.push({
      operation: "create_adset",
      correlation,
      name: `existing:${params.payload.adSet.existingAdSetId}`,
      requestHash: sha256Canonical({
        op: "create_adset",
        existing: params.payload.adSet.existingAdSetId,
      }),
      status: "succeeded",
      externalId: params.payload.adSet.existingAdSetId,
    });
  } else {
    const correlation = uuidv7();
    const name = formatCorrelatedName(params.payload.adSet.name, correlation);
    steps.push({
      operation: "create_adset",
      correlation,
      name,
      requestHash: sha256Canonical({
        op: "create_adset",
        name,
        goal: params.payload.adSet.optimizationGoal,
      }),
      status: "pending",
      externalId: null,
    });
  }

  // One creative + one ad per creative (first creative drives creative/ad steps
  // for the chain; multi-creative expands to additional create_creative/create_ad
  // pairs keeping index order).
  for (const creative of params.payload.creatives) {
    const creativeCorrelation = uuidv7();
    const creativeName = formatCorrelatedName(creative.name, creativeCorrelation);
    steps.push({
      operation: "create_creative",
      correlation: creativeCorrelation,
      name: creativeName,
      requestHash: sha256Canonical({
        op: "create_creative",
        creativeId: creative.creativeId,
        name: creativeName,
        linkUrl: creative.linkUrl,
      }),
      status: "pending",
      externalId: null,
    });

    const adCorrelation = uuidv7();
    const adName = formatCorrelatedName(creative.adName, adCorrelation);
    steps.push({
      operation: "create_ad",
      correlation: adCorrelation,
      name: adName,
      requestHash: sha256Canonical({
        op: "create_ad",
        creativeId: creative.creativeId,
        name: adName,
      }),
      status: "pending",
      externalId: null,
    });
  }

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    await db.query(
      `INSERT INTO publication_step (
         id, publication_id, tenant_id, step_index, operation,
         request_hash, status, external_id, attempt,
         reconcile_state, external_correlation, object_name
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         'none', $10, $11
       )`,
      [
        uuidv7(),
        publicationId,
        params.tenantId,
        i,
        step.operation,
        step.requestHash,
        step.status,
        step.externalId,
        step.status === "succeeded" ? 1 : 0,
        step.correlation,
        step.name,
      ],
    );
  }

  return { publicationId };
}

async function loadPublication(
  db: Queryable,
  publicationId: string,
  tenantId: string,
): Promise<{ publication: PublicationRow; steps: StepRow[] }> {
  const pub = await db.query<PublicationRow>(
    `SELECT id, tenant_id, status, resolved_payload, deviation_reason
     FROM publication WHERE id = $1 AND tenant_id = $2`,
    [publicationId, tenantId],
  );
  const publication = pub.rows[0];
  if (!publication) throw new PublishError("validation_error", { reason: "missing_publication" });

  const steps = await db.query<StepRow>(
    `SELECT * FROM publication_step
     WHERE publication_id = $1
     ORDER BY step_index ASC`,
    [publicationId],
  );
  return { publication, steps: steps.rows };
}

async function markStepInFlight(
  db: Queryable,
  step: StepRow,
  leaseMs: number,
): Promise<StepRow | null> {
  const leaseExpires = new Date(publishNow().getTime() + leaseMs).toISOString();
  const result = await db.query<StepRow>(
    `UPDATE publication_step
     SET status = 'in_flight',
         attempt = attempt + 1,
         lease_expires_at = $2::timestamptz,
         reconcile_state = 'none',
         updated_at = now()
     WHERE id = $1
       AND status IN ('pending', 'failed')
     RETURNING *`,
    [step.id, leaseExpires],
  );
  return result.rows[0] ?? null;
}

async function markStepSucceeded(
  db: Queryable,
  stepId: string,
  externalId: string,
): Promise<void> {
  await db.query(
    `UPDATE publication_step
     SET status = 'succeeded',
         external_id = $2,
         lease_expires_at = NULL,
         reconcile_state = 'none',
         error = NULL,
         updated_at = now()
     WHERE id = $1`,
    [stepId, externalId],
  );
}

async function markStepFailed(
  db: Queryable,
  stepId: string,
  error: unknown,
): Promise<void> {
  await db.query(
    `UPDATE publication_step
     SET status = 'failed',
         error = $2::jsonb,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1`,
    [stepId, JSON.stringify({ message: String(error) })],
  );
}

/**
 * Expired in_flight → reconcile, never blind retry. If the object is found
 * via correlation in the name, mark succeeded. If not found and lease
 * expired: needs_human_review (prefer hung publish over a duplicate).
 */
async function reconcileExpiredStep(
  db: Queryable,
  client: WriteClient,
  publication: PublicationRow,
  step: StepRow,
): Promise<"resolved" | "needs_human_review"> {
  await db.query(
    `UPDATE publication_step
     SET reconcile_state = 'pending', updated_at = now()
     WHERE id = $1`,
    [step.id],
  );

  const marker = `[adloop:${step.external_correlation}]`;
  const found = await client.searchByName({
    adAccountId: publication.resolved_payload.metaAdAccountExternalId,
    edge: edgeForOperation(step.operation),
    nameContains: marker,
  });

  if (found.length === 1) {
    await db.query(
      `UPDATE publication_step
       SET status = 'succeeded',
           external_id = $2,
           reconcile_state = 'resolved',
           reconciled_at = now(),
           lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [step.id, found[0]!.id],
    );
    return "resolved";
  }

  if (found.length > 1) {
    // Ambiguous — human must decide.
    await db.query(
      `UPDATE publication_step
       SET reconcile_state = 'needs_human_review',
           error = $2::jsonb,
           updated_at = now()
       WHERE id = $1`,
      [
        step.id,
        JSON.stringify({
          code: "needs_human_review",
          reason: "ambiguous_reconcile",
          count: found.length,
        }),
      ],
    );
    await db.query(
      `UPDATE publication
       SET status = 'needs_human_review', updated_at = now()
       WHERE id = $1`,
      [publication.id],
    );
    return "needs_human_review";
  }

  // Nothing found after lease expiry — do NOT retry. Prefer hung publish.
  await db.query(
    `UPDATE publication_step
     SET reconcile_state = 'needs_human_review',
         error = $2::jsonb,
         updated_at = now()
     WHERE id = $1`,
    [
      step.id,
      JSON.stringify({
        code: "needs_human_review",
        reason: "lease_expired_no_object",
      }),
    ],
  );
  await db.query(
    `UPDATE publication
     SET status = 'needs_human_review', updated_at = now()
     WHERE id = $1`,
    [publication.id],
  );
  return "needs_human_review";
}

function campaignIdFromSteps(steps: StepRow[]): string {
  const step = steps.find((s) => s.operation === "create_campaign");
  if (!step?.external_id) throw new Error("campaign_id_missing");
  return step.external_id;
}

function adSetIdFromSteps(steps: StepRow[]): string {
  const step = steps.find((s) => s.operation === "create_adset");
  if (!step?.external_id) throw new Error("adset_id_missing");
  return step.external_id;
}

function creativeIdForAdStep(
  steps: StepRow[],
  adStepIndex: number,
): string {
  // Immediate preceding create_creative for this ad.
  for (let i = adStepIndex - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (step.operation === "create_creative" && step.external_id) {
      return step.external_id;
    }
  }
  throw new Error("creative_id_missing_for_ad");
}

function creativePayloadForStep(
  payload: ResolvedPublishPayload,
  steps: StepRow[],
  creativeStepIndex: number,
): ResolvedPublishPayload["creatives"][number] {
  const creativeSteps = steps.filter((s) => s.operation === "create_creative");
  const ordinal = creativeSteps.findIndex((s) => s.step_index === creativeStepIndex);
  const creative = payload.creatives[ordinal];
  if (!creative) throw new Error("creative_payload_missing");
  return creative;
}

async function executeStep(
  db: Queryable,
  client: WriteClient,
  store: ObjectStore,
  publication: PublicationRow,
  step: StepRow,
  steps: StepRow[],
  signal?: AbortSignal,
): Promise<string> {
  const payload = publication.resolved_payload;
  const accountId = payload.metaAdAccountExternalId;

  // Hard gate: never send ACTIVE.
  if (payload.status !== META_PUBLISH_STATUS) {
    throw new PublishError("validation_error", { reason: "status_must_be_paused" });
  }

  switch (step.operation) {
    case "create_campaign": {
      if (payload.campaign.mode !== "new") {
        throw new Error("create_campaign_but_existing");
      }
      const dailyBudget =
        payload.budgetSource?.level === "campaign"
          ? payload.budgetSource.amount
          : undefined;
      const result = await client.createCampaign({
        adAccountId: accountId,
        name: step.object_name,
        objective: payload.campaign.objective,
        isAdsetBudgetSharingEnabled: payload.campaign.isAdsetBudgetSharingEnabled,
        dailyBudget,
        signal,
      });
      return result.id;
    }
    case "create_adset": {
      if (payload.adSet.mode !== "new") {
        throw new Error("create_adset_but_existing");
      }
      const dailyBudget =
        payload.budgetSource?.level === "adset"
          ? payload.budgetSource.amount
          : undefined;
      // CBO: must not send budget on ad set.
      if (
        payload.budgetMode === "CBO" &&
        dailyBudget !== undefined
      ) {
        throw new PublishError("budget_wrong_level", { level: "adset" });
      }
      const result = await client.createAdSet({
        adAccountId: accountId,
        campaignId: campaignIdFromSteps(steps),
        name: step.object_name,
        optimizationGoal: payload.adSet.optimizationGoal,
        billingEvent: payload.adSet.billingEvent,
        bidStrategy: payload.adSet.bidStrategy,
        bidAmount: payload.adSet.bidAmount,
        dailyBudget,
        targeting: payload.adSet.targeting,
        attributionSpec: payload.adSet.attributionSpec,
        promotedObject: payload.adSet.promotedObject,
        startTime: payload.adSet.startTime,
        dsaBeneficiary: payload.adSet.dsaBeneficiary,
        dsaPayor: payload.adSet.dsaPayor,
        signal,
      });
      return result.id;
    }
    case "create_creative": {
      const creative = creativePayloadForStep(payload, steps, step.step_index);
      const image = await store.getObject(creative.storageKey, signal);
      const uploaded = await client.uploadAdImage({
        adAccountId: accountId,
        bytes: image.body,
        filename: `${creative.creativeId}.png`,
        signal,
      });
      const result = await client.createAdCreative({
        adAccountId: accountId,
        name: step.object_name,
        pageId: creative.pageId,
        instagramActorId: creative.instagramActorId,
        imageHash: uploaded.hash,
        linkUrl: creative.linkUrl,
        message: creative.primaryText,
        headline: creative.headline,
        description: creative.description,
        callToAction: creative.callToAction,
        signal,
      });
      return result.id;
    }
    case "create_ad": {
      const creative = creativePayloadForStep(
        payload,
        steps,
        // ad step follows its creative; use creative payload by ordinal
        steps.find(
          (s) =>
            s.operation === "create_creative" &&
            s.step_index === step.step_index - 1,
        )?.step_index ?? step.step_index - 1,
      );
      void creative;
      const result = await client.createAd({
        adAccountId: accountId,
        adSetId: adSetIdFromSteps(steps),
        creativeId: creativeIdForAdStep(steps, step.step_index),
        name: step.object_name,
        signal,
      });
      return result.id;
    }
  }
}

export type RunPublicationResult =
  | { status: "succeeded"; publicationId: string; externalIds: Record<string, string> }
  | { status: "failed"; publicationId: string; code: string }
  | { status: "needs_human_review"; publicationId: string; code: "needs_human_review" };

/**
 * Drive the publication step chain. Resumes at the first unconfirmed step.
 * Expired in_flight goes to reconcile — never a second Meta create.
 */
export async function runPublication(
  db: Queryable,
  params: {
    publicationId: string;
    tenantId: string;
    client: WriteClient;
    store: ObjectStore;
    leaseMs?: number;
    signal?: AbortSignal;
  },
): Promise<RunPublicationResult> {
  const leaseMs = params.leaseMs ?? DEFAULT_STEP_LEASE_MS;
  let { publication, steps } = await loadPublication(
    db,
    params.publicationId,
    params.tenantId,
  );

  if (publication.status === "succeeded") {
    const externalIds: Record<string, string> = {};
    for (const step of steps) {
      if (step.external_id) externalIds[step.operation] = step.external_id;
    }
    return { status: "succeeded", publicationId: publication.id, externalIds };
  }
  if (publication.status === "needs_human_review") {
    return {
      status: "needs_human_review",
      publicationId: publication.id,
      code: "needs_human_review",
    };
  }

  await db.query(
    `UPDATE publication SET status = 'in_progress', updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'in_progress', 'failed')`,
    [publication.id],
  );

  for (let i = 0; i < steps.length; i += 1) {
    let step = steps[i]!;
    if (step.status === "succeeded") continue;

    if (step.reconcile_state === "needs_human_review") {
      return {
        status: "needs_human_review",
        publicationId: publication.id,
        code: "needs_human_review",
      };
    }

    // Expired in_flight → reconcile, not retry.
    if (step.status === "in_flight") {
      const leaseExpired =
        step.lease_expires_at !== null &&
        new Date(step.lease_expires_at).getTime() <= publishNow().getTime();
      if (!leaseExpired) {
        // Still leased by another worker — stop.
        return {
          status: "failed",
          publicationId: publication.id,
          code: "step_in_flight",
        };
      }
      const outcome = await reconcileExpiredStep(
        db,
        params.client,
        publication,
        step,
      );
      if (outcome === "needs_human_review") {
        return {
          status: "needs_human_review",
          publicationId: publication.id,
          code: "needs_human_review",
        };
      }
      // Reload after reconcile.
      ({ publication, steps } = await loadPublication(
        db,
        params.publicationId,
        params.tenantId,
      ));
      step = steps[i]!;
      if (step.status === "succeeded") continue;
    }

    const claimed = await markStepInFlight(db, step, leaseMs);
    if (!claimed) {
      return {
        status: "failed",
        publicationId: publication.id,
        code: "step_claim_failed",
      };
    }
    step = claimed;

    try {
      // Refresh sibling step ids for dependency lookups.
      ({ steps } = await loadPublication(db, params.publicationId, params.tenantId));
      const externalId = await executeStep(
        db,
        params.client,
        params.store,
        publication,
        step,
        steps,
        params.signal,
      );
      // Persist immediately — before any further work.
      await markStepSucceeded(db, step.id, externalId);
      ({ steps } = await loadPublication(db, params.publicationId, params.tenantId));

      // Crash AFTER persist models process death. The step stays succeeded;
      // do not mark failed — resume must continue at the next step.
      try {
        await maybeCrashAfterPersist(step.operation, externalId);
      } catch {
        await db.query(
          `UPDATE publication SET status = 'failed', updated_at = now() WHERE id = $1`,
          [publication.id],
        );
        return {
          status: "failed",
          publicationId: publication.id,
          code: "injected_crash_after_persist",
        };
      }
    } catch (error) {
      await markStepFailed(db, step.id, error);
      await db.query(
        `UPDATE publication SET status = 'failed', updated_at = now() WHERE id = $1`,
        [publication.id],
      );
      return {
        status: "failed",
        publicationId: publication.id,
        code: error instanceof PublishError ? error.code : "step_failed",
      };
    }
  }

  await db.query(
    `UPDATE publication SET status = 'succeeded', updated_at = now() WHERE id = $1`,
    [publication.id],
  );

  const externalIds: Record<string, string> = {};
  const final = await loadPublication(db, params.publicationId, params.tenantId);
  for (const step of final.steps) {
    if (step.external_id) {
      // Last id wins per operation (multi-creative keeps last).
      externalIds[`${step.operation}:${step.step_index}`] = step.external_id;
      externalIds[step.operation] = step.external_id;
    }
  }

  // Verify ads are PAUSED.
  for (const step of final.steps) {
    if (step.operation === "create_ad" && step.external_id) {
      const status = await params.client.getObjectStatus(step.external_id);
      if (status.status !== META_PUBLISH_STATUS) {
        throw new PublishError("validation_error", {
          reason: "ad_not_paused",
          status: status.status ?? "unknown",
        });
      }
    }
  }

  return {
    status: "succeeded",
    publicationId: publication.id,
    externalIds,
  };
}
