import { z } from "zod";
import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import { getObjectStore } from "@/storage/object-store";
import { HandlerError } from "../errors";
import type { JobFamilyDefinition } from "../types";
import {
  createPublication,
  runPublication,
} from "@/publish/chain";
import { getWriteClientOrThrow } from "@/publish/client-factory";
import { buildLiveWriteClient } from "@/publish/live-client";
import {
  META_PUBLISH_STATUS,
  ResolvedPublishPayloadSchema,
} from "@/publish/schemas";

const InputSchema = z.object({
  resolved: ResolvedPublishPayloadSchema,
  /** When resuming an existing publication (idempotent retry). */
  publicationId: z.string().uuid().nullable(),
});

const ResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    publicationId: z.string().uuid(),
    externalIds: z.record(z.string()),
  }),
  z.object({
    status: z.literal("needs_human_review"),
    publicationId: z.string().uuid(),
    code: z.literal("needs_human_review"),
  }),
  z.object({
    status: z.literal("failed"),
    publicationId: z.string().uuid(),
    code: z.string(),
  }),
]);

type Input = z.infer<typeof InputSchema>;
type Result = z.infer<typeof ResultSchema>;

export const metaPublishFamily: JobFamilyDefinition<Input, Result> = {
  name: "meta_publish",
  inputSchema: InputSchema,
  resultSchema: ResultSchema,
  maxAttempts: 10,
  timeoutMs: 5 * 60 * 1_000,
  backoffBaseMs: 5_000,
  backoffMaxMs: 60_000,

  async handler(ctx) {
    const payload = ctx.input.resolved;
    if (payload.status !== META_PUBLISH_STATUS) {
      throw new HandlerError(
        "status_must_be_paused",
        "status_must_be_paused",
        false,
      );
    }

    const pool = getPool();
    let publicationId = ctx.input.publicationId;

    if (!publicationId) {
      const created = await createPublication(pool, {
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        payload,
      });
      publicationId = created.publicationId;
    }

    const live =
      env.NODE_ENV === "test"
        ? null
        : await buildLiveWriteClient(ctx.tenantId, payload.metaAdAccountId);
    const client = getWriteClientOrThrow(live);
    const store = getObjectStore();

    const outcome = await runPublication(pool, {
      publicationId,
      tenantId: ctx.tenantId,
      client,
      store,
      signal: ctx.signal,
    });

    if (outcome.status === "failed" && outcome.code === "step_in_flight") {
      throw new HandlerError("step_in_flight", "step_in_flight", true);
    }

    if (outcome.status === "needs_human_review") {
      return {
        status: "needs_human_review" as const,
        publicationId: outcome.publicationId,
        code: "needs_human_review" as const,
      };
    }

    return outcome;
  },
};
