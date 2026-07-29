import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { getPool } from "@/db/pool";
import { createRun } from "@/queue/create-run";
import type { ToolDefinition } from "@/agent/tools/types";
import { PublishAgentInputSchema, PublishError, ResolvedPublishPayloadSchema } from "@/publish/schemas";
import { resolvePublishPayload } from "@/publish/resolve";
import {
  buildLiveWriteClient,
  campaignReaderFromClient,
} from "@/publish/live-client";
import { getWriteClientOrThrow } from "@/publish/client-factory";

/**
 * Expensive external tool. Schema has NO budget and NO status.
 * Budget can only enter via the Launch API human path that seals the
 * resolved payload before Freigabe — agent resolve always fails with
 * budget_required when the CBO matrix needs one.
 */
export const publishAdsTool: ToolDefinition<
  z.infer<typeof PublishAgentInputSchema>,
  unknown
> = {
  name: "publish_ads",
  version: "1",
  description:
    "Publish creatives to Meta as PAUSED ads. Requires human Freigabe. Never activates ads.",
  inputSchema: PublishAgentInputSchema,
  kind: "async_submit",
  costClass: "expensive",
  sideEffect: "external",
  jobFamily: "meta_publish",

  async resolve(raw, ctx) {
    // Agent path: no budget field exists on the schema. Resolve will throw
    // budget_required when placement requires one.
    let campaignReader;
    if (raw.campaign.mode === "existing") {
      const live = await buildLiveWriteClient(ctx.tenantId, raw.metaAdAccountId);
      campaignReader = campaignReaderFromClient(getWriteClientOrThrow(live));
    }
    try {
      const resolved = await resolvePublishPayload(getPool(), {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        input: raw,
        allowHumanBudget: false,
        campaignReader,
      });
      return ResolvedPublishPayloadSchema.parse(resolved);
    } catch (error) {
      if (error instanceof PublishError) {
        throw error;
      }
      throw error;
    }
  },

  async handler(resolvedPayload, ctx) {
    const payload = ResolvedPublishPayloadSchema.parse(resolvedPayload);
    const pool = getPool();
    const runId = uuidv7();
    const created = await createRun(pool, {
      runId,
      tenantId: ctx.tenantId,
      family: "meta_publish",
      input: {
        resolved: payload,
        publicationId: null,
      },
    });
    return {
      submittedRunId: runId,
      outcome: created.outcome,
      idempotencyKey: payload.idempotencyKey,
    };
  },
};
