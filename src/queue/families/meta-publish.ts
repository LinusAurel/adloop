import { z } from "zod";
import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import { decryptToken } from "@/meta/token-crypto";
import { MetaGraphClient } from "@/meta/graph-client";
import { MetaWriteClient } from "@/meta/write-client";
import { getObjectStore } from "@/storage/object-store";
import { HandlerError } from "../errors";
import type { JobFamilyDefinition } from "../types";
import {
  createPublication,
  runPublication,
} from "@/publish/chain";
import { getWriteClientOrThrow } from "@/publish/client-factory";
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

async function buildLiveWriteClient(
  tenantId: string,
  metaAdAccountId: string,
): Promise<MetaWriteClient> {
  if (!env.ENCRYPTION_KEY) {
    throw new HandlerError(
      "meta_not_configured",
      "ENCRYPTION_KEY missing",
      false,
    );
  }
  const pool = getPool();
  const row = await pool.query<{ token_encrypted: string }>(
    `SELECT c.token_encrypted
     FROM meta_ad_account a
     JOIN meta_connection c ON c.id = a.connection_id
     WHERE a.id = $1 AND a.tenant_id = $2`,
    [metaAdAccountId, tenantId],
  );
  const tokenRow = row.rows[0];
  if (!tokenRow) {
    throw new HandlerError("account_not_found", "account_not_found", false);
  }
  const accessToken = decryptToken(tokenRow.token_encrypted, env.ENCRYPTION_KEY);
  const graph = new MetaGraphClient({
    accessToken,
    apiVersion: env.META_GRAPH_API_VERSION,
  });
  return new MetaWriteClient(graph);
}

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
