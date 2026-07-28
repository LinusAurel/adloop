import {
  createHmac,
  randomBytes,
} from "node:crypto";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import type { Pool } from "pg";
import type { Session } from "@/auth/session";
import { withTransaction } from "@/db/queryable";
import { env } from "@/lib/env";
import { MetaGraphClient, type PageResult } from "./graph-client";
import { encryptToken } from "./token-crypto";

const REQUIRED_SCOPES = [
  "ads_read",
  "ads_management",
  "business_management",
] as const;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
});

const MeSchema = z.object({ id: z.string().min(1) });

const PermissionsSchema = z.object({
  data: z.array(
    z.object({
      permission: z.string(),
      status: z.string(),
    }),
  ),
});

export const MetaAdAccountSchema = z.object({
  id: z.string().regex(/^act_\d+$/),
  name: z.string(),
  currency: z.string().min(3),
  timezone_name: z.string().min(1),
  timezone_offset_hours_utc: z.number(),
  account_status: z.number().int(),
  business: z.object({ name: z.string() }).optional(),
});

const MetaAdAccountPageSchema: z.ZodType<PageResult<z.infer<typeof MetaAdAccountSchema>>> =
  z.object({
    data: z.array(MetaAdAccountSchema),
    paging: z
      .object({
        next: z.string().url().optional(),
        cursors: z.object({ after: z.string().optional() }).optional(),
      })
      .optional(),
  });

export const ReadinessSchema = z.record(
  z.object({
    status: z.enum(["ready", "syncing", "optional_pending", "error"]),
    progress: z
      .object({
        labelCode: z.string(),
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        percent: z.number().int().min(0).max(100).optional(),
      })
      .optional(),
    blocks: z.array(z.string()),
    messageCode: z.string().optional(),
    params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
);

export type Readiness = z.infer<typeof ReadinessSchema>;

export function initialReadiness(): Readiness {
  return ReadinessSchema.parse({
    connection: { status: "ready", blocks: [] },
    identity: { status: "ready", blocks: [] },
    base_facts: {
      status: "optional_pending",
      blocks: ["strategist", "insights"],
      messageCode: "base_facts_not_synced",
    },
    performance_facts: { status: "optional_pending", blocks: [] },
  });
}

interface MetaConfiguration {
  appId: string;
  appSecret: string;
  redirectUri: string;
  encryptionKey: string;
  apiVersion: string;
}

export function metaConfiguration(): MetaConfiguration | null {
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_REDIRECT_URI || !env.ENCRYPTION_KEY) {
    return null;
  }
  return {
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
    redirectUri: env.META_REDIRECT_URI,
    encryptionKey: env.ENCRYPTION_KEY,
    apiVersion: env.META_GRAPH_API_VERSION,
  };
}

function stateHash(value: string): string {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`meta-oauth-state:${value}`)
    .digest("hex");
}

export async function createOAuthUrl(
  pool: Pool,
  session: Session,
  configuration: MetaConfiguration,
): Promise<URL> {
  const state = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO meta_oauth_state (
       id, tenant_id, app_user_id, state_hash, expires_at
     ) VALUES (
       $1, $2, $3, $4, now() + interval '10 minutes'
     )`,
    [uuidv7(), session.tenantId, session.userId, stateHash(state)],
  );

  const url = new URL(`https://www.facebook.com/${configuration.apiVersion}/dialog/oauth`);
  url.searchParams.set("client_id", configuration.appId);
  url.searchParams.set("redirect_uri", configuration.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", REQUIRED_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  return url;
}

async function consumeOAuthState(
  pool: Pool,
  session: Session,
  state: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE meta_oauth_state
     SET consumed_at = now()
     WHERE state_hash = $1
       AND tenant_id = $2
       AND app_user_id = $3
       AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING id`,
    [stateHash(state), session.tenantId, session.userId],
  );
  return result.rowCount === 1;
}

async function fetchOAuthToken(
  configuration: MetaConfiguration,
  params: Readonly<Record<string, string>>,
): Promise<z.infer<typeof TokenResponseSchema>> {
  const url = new URL(`https://graph.facebook.com/${configuration.apiVersion}/oauth/access_token`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("meta_oauth_exchange_failed");
  const parsed = TokenResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("meta_oauth_response_invalid");
  return parsed.data;
}

async function exchangeCode(
  configuration: MetaConfiguration,
  code: string,
): Promise<z.infer<typeof TokenResponseSchema>> {
  const shortToken = await fetchOAuthToken(configuration, {
    client_id: configuration.appId,
    client_secret: configuration.appSecret,
    redirect_uri: configuration.redirectUri,
    code,
  });

  return fetchOAuthToken(configuration, {
    grant_type: "fb_exchange_token",
    client_id: configuration.appId,
    client_secret: configuration.appSecret,
    fb_exchange_token: shortToken.access_token,
  });
}

async function persistAdAccounts(
  pool: Pool,
  session: Session,
  connectionId: string,
  accounts: z.infer<typeof MetaAdAccountSchema>[],
): Promise<void> {
  await withTransaction(pool, async (client) => {
    for (const account of accounts) {
      const existing = await client.query<{ advertiser_id: string }>(
        `SELECT advertiser_id
         FROM meta_ad_account
         WHERE tenant_id = $1 AND meta_ad_account_id = $2`,
        [session.tenantId, account.id],
      );
      const advertiserId = existing.rows[0]?.advertiser_id ?? uuidv7();
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO advertiser (id, tenant_id, name, content_locale)
           VALUES ($1, $2, $3, 'de-DE')`,
          [advertiserId, session.tenantId, account.name],
        );
      }

      await client.query(
        `INSERT INTO meta_ad_account (
           id, tenant_id, connection_id, advertiser_id,
           meta_ad_account_id, name, currency, timezone_name,
           timezone_offset_hours, account_status, business_name,
           selected, readiness, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           false, $12::jsonb, now(), now()
         )
         ON CONFLICT (tenant_id, meta_ad_account_id) DO UPDATE SET
           connection_id = EXCLUDED.connection_id,
           name = EXCLUDED.name,
           currency = EXCLUDED.currency,
           timezone_name = EXCLUDED.timezone_name,
           timezone_offset_hours = EXCLUDED.timezone_offset_hours,
           account_status = EXCLUDED.account_status,
           business_name = EXCLUDED.business_name,
           updated_at = now()`,
        [
          uuidv7(),
          session.tenantId,
          connectionId,
          advertiserId,
          account.id,
          account.name,
          account.currency,
          account.timezone_name,
          account.timezone_offset_hours_utc,
          account.account_status,
          account.business?.name ?? null,
          JSON.stringify(initialReadiness()),
        ],
      );
    }
  });
}

export async function completeMetaOAuth(params: {
  pool: Pool;
  session: Session;
  code: string;
  state: string;
  configuration: MetaConfiguration;
}): Promise<{ connectionId: string; adAccountCount: number }> {
  if (!(await consumeOAuthState(params.pool, params.session, params.state))) {
    throw new Error("invalid_oauth_state");
  }

  const token = await exchangeCode(params.configuration, params.code);
  const graph = new MetaGraphClient({
    accessToken: token.access_token,
    apiVersion: params.configuration.apiVersion,
  });
  const [me, permissions] = await Promise.all([
    graph.request("/me?fields=id", MeSchema),
    graph.request("/me/permissions", PermissionsSchema),
  ]);
  const granted = permissions.data.data
    .filter((permission) => permission.status === "granted")
    .map((permission) => permission.permission);
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) throw new Error("missing_meta_scopes");

  const connectionId = uuidv7();
  const encrypted = encryptToken(token.access_token, params.configuration.encryptionKey);
  const connection = await params.pool.query<{ id: string }>(
    `INSERT INTO meta_connection (
       id, tenant_id, meta_user_id, token_encrypted, token_expires_at,
       scopes, status, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4,
       now() + ($5 || ' seconds')::interval,
       $6::text[], 'ready', now(), now()
     )
     ON CONFLICT (tenant_id, meta_user_id) DO UPDATE SET
       token_encrypted = EXCLUDED.token_encrypted,
       token_expires_at = EXCLUDED.token_expires_at,
       scopes = EXCLUDED.scopes,
       status = 'ready',
       last_error = NULL,
       updated_at = now()
     RETURNING id`,
    [
      connectionId,
      params.session.tenantId,
      me.data.id,
      encrypted,
      token.expires_in,
      [...granted].sort(),
    ],
  );
  const persistedConnectionId = connection.rows[0]!.id;

  const accounts: z.infer<typeof MetaAdAccountSchema>[] = [];
  await graph.paginate({
    path:
      "/me/adaccounts?fields=id,name,currency,timezone_name,timezone_offset_hours_utc,account_status,business{name}",
    pageSchema: MetaAdAccountPageSchema,
    onPage: async (page) => {
      accounts.push(...page.data);
    },
  });
  await persistAdAccounts(params.pool, params.session, persistedConnectionId, accounts);
  return { connectionId: persistedConnectionId, adAccountCount: accounts.length };
}
