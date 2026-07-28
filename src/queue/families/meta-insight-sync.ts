import { z } from "zod";
import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import {
  executeInsightSync,
  type SyncWindow,
} from "@/meta/insight-sync";
import {
  MetaGraphClient,
  MetaGraphError,
  MetaResponseValidationError,
} from "@/meta/graph-client";
import { initialReadiness, ReadinessSchema } from "@/meta/oauth";
import { decryptToken } from "@/meta/token-crypto";
import { getObjectStore } from "@/storage/object-store";
import { HandlerError, JobCancelledError } from "../errors";
import type { JobFamilyDefinition } from "../types";

const InputSchema = z.object({
  metaAdAccountId: z.string().uuid(),
  syncRunId: z.string().uuid(),
  windowStart: z.string().date(),
  windowEnd: z.string().date(),
});

const ResultSchema = z.object({
  syncRunId: z.string().uuid(),
  pagesFetched: z.number().int().nonnegative(),
  rawResponseKey: z.string().min(1),
});

type Input = z.infer<typeof InputSchema>;
type Result = z.infer<typeof ResultSchema>;

interface AccountConnectionRow {
  tenant_id: string;
  meta_ad_account_id: string;
  timezone_name: string;
  connection_id: string;
  token_encrypted: string;
  token_expires_at: Date;
}

function graphFailure(error: MetaGraphError) {
  return {
    error: "meta_graph_error",
    params: {
      code: error.code,
      ...(error.errorSubcode === undefined ? {} : { errorSubcode: error.errorSubcode }),
      ...(error.fbtraceId === undefined ? {} : { fbtraceId: error.fbtraceId }),
    },
  };
}

function errorReadiness(messageCode: string) {
  const readiness = initialReadiness();
  readiness.base_facts = {
    status: "error",
    blocks: ["strategist", "insights"],
    messageCode,
  };
  return ReadinessSchema.parse(readiness);
}

export const metaInsightSyncFamily: JobFamilyDefinition<Input, Result> = {
  name: "meta_insight_sync",
  inputSchema: InputSchema,
  resultSchema: ResultSchema,
  maxAttempts: 5,
  timeoutMs: 30 * 60 * 1_000,

  async handler(ctx) {
    const pool = getPool();
    const accountResult = await pool.query<AccountConnectionRow>(
      `SELECT
         a.tenant_id,
         a.meta_ad_account_id,
         a.timezone_name,
         a.connection_id,
         c.token_encrypted,
         c.token_expires_at
       FROM meta_ad_account a
       JOIN meta_connection c
         ON c.id = a.connection_id
        AND c.tenant_id = a.tenant_id
       WHERE a.id = $1
         AND a.tenant_id = $2`,
      [ctx.input.metaAdAccountId, ctx.tenantId],
    );
    const account = accountResult.rows[0];
    if (!account) throw new HandlerError("META_ACCOUNT_NOT_FOUND", "meta_account_not_found", false);
    const markAccountError = async (messageCode: string): Promise<void> => {
      await ctx.withLease(
        async (client) => {
          await client.query(
            `UPDATE meta_ad_account
             SET readiness = $1::jsonb, updated_at = now()
             WHERE id = $2 AND tenant_id = $3`,
            [
              JSON.stringify(errorReadiness(messageCode)),
              ctx.input.metaAdAccountId,
              account.tenant_id,
            ],
          );
        },
        { allowAfterCancellation: true },
      );
    };
    if (account.token_expires_at.getTime() <= Date.now()) {
      await ctx.withLease(async (client) => {
        await client.query(
          `UPDATE meta_connection
           SET status = 'expired',
               last_error = '{"error":"token_expired"}'::jsonb,
               updated_at = now()
           WHERE id = $1 AND tenant_id = $2`,
          [account.connection_id, account.tenant_id],
        );
        await client.query(
          `UPDATE meta_ad_account
           SET readiness = $1::jsonb, updated_at = now()
           WHERE id = $2 AND tenant_id = $3`,
          [
            JSON.stringify(errorReadiness("token_expired")),
            ctx.input.metaAdAccountId,
            account.tenant_id,
          ],
        );
      });
      throw new HandlerError("TOKEN_EXPIRED", "token_expired", false);
    }
    if (!env.ENCRYPTION_KEY) {
      await markAccountError("meta_not_configured");
      throw new HandlerError("META_NOT_CONFIGURED", "meta_not_configured", false);
    }

    const graph = new MetaGraphClient({
      accessToken: decryptToken(account.token_encrypted, env.ENCRYPTION_KEY),
      apiVersion: env.META_GRAPH_API_VERSION,
    });
    const window: SyncWindow = {
      start: ctx.input.windowStart,
      end: ctx.input.windowEnd,
    };

    try {
      return await executeInsightSync({
        pool,
        tenantId: account.tenant_id,
        internalAdAccountId: ctx.input.metaAdAccountId,
        externalAdAccountId: account.meta_ad_account_id,
        accountTimezone: account.timezone_name,
        apiVersion: env.META_GRAPH_API_VERSION,
        syncRunId: ctx.input.syncRunId,
        window,
        graph,
        objectStore: getObjectStore(),
        signal: ctx.signal,
        progress: ctx.progress,
        withLease: ctx.withLease,
      });
    } catch (error) {
      if (ctx.signal.aborted || error instanceof JobCancelledError) {
        throw new JobCancelledError();
      }
      if (error instanceof MetaGraphError) {
        await ctx.withLease(async (client) => {
          await client.query(
            `UPDATE meta_connection
             SET status = 'error',
                 last_error = $1::jsonb,
                 updated_at = now()
             WHERE id = $2 AND tenant_id = $3`,
            [
              JSON.stringify(graphFailure(error)),
              account.connection_id,
              account.tenant_id,
            ],
          );
        });
        await markAccountError("meta_graph_error");
        throw new HandlerError("META_GRAPH_ERROR", "meta_graph_error", error.retryable);
      }
      if (error instanceof MetaResponseValidationError) {
        await markAccountError("meta_response_invalid");
        throw new HandlerError("META_RESPONSE_INVALID", "meta_response_invalid", false);
      }
      await markAccountError("meta_sync_failed");
      throw new HandlerError("META_SYNC_FAILED", "meta_sync_failed", true);
    }
  },
};
