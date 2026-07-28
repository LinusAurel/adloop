import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { metaConfiguration, ReadinessSchema } from "@/meta/oauth";

const ConnectionRowSchema = z.object({
  id: z.string().uuid(),
  meta_user_id: z.string(),
  token_expires_at: z.coerce.date(),
  scopes: z.array(z.string()),
  status: z.string(),
  last_error: z.unknown().nullable(),
});

const AccountRowSchema = z.object({
  id: z.string().uuid(),
  connection_id: z.string().uuid(),
  advertiser_id: z.string().uuid(),
  meta_ad_account_id: z.string(),
  name: z.string(),
  currency: z.string(),
  timezone_name: z.string(),
  timezone_offset_hours: z.coerce.number(),
  account_status: z.number().int(),
  business_name: z.string().nullable(),
  selected: z.boolean(),
  readiness: ReadinessSchema,
  content_locale: z.string(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const pool = getPool();
  const [connectionsResult, accountsResult] = await Promise.all([
    pool.query(
      `SELECT id, meta_user_id, token_expires_at, scopes, status, last_error
       FROM meta_connection
       WHERE tenant_id = $1
       ORDER BY created_at`,
      [auth.session.tenantId],
    ),
    pool.query(
      `SELECT
         a.id, a.connection_id, a.advertiser_id, a.meta_ad_account_id, a.name,
         a.currency, a.timezone_name, a.timezone_offset_hours, a.account_status,
         a.business_name, a.selected, a.readiness, adv.content_locale
       FROM meta_ad_account a
       JOIN advertiser adv
         ON adv.id = a.advertiser_id
        AND adv.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1
       ORDER BY a.name, a.meta_ad_account_id`,
      [auth.session.tenantId],
    ),
  ]);
  const connections = z.array(ConnectionRowSchema).parse(connectionsResult.rows);
  const accounts = z.array(AccountRowSchema).parse(accountsResult.rows);
  const now = Date.now();

  return NextResponse.json({
    metaConfigured: metaConfiguration() !== null,
    connections: connections.map((connection) => {
      const expiresInDays = Math.ceil(
        (connection.token_expires_at.getTime() - now) / (24 * 60 * 60 * 1_000),
      );
      return {
        id: connection.id,
        metaUserId: connection.meta_user_id,
        tokenExpiresAt: connection.token_expires_at.toISOString(),
        expiresInDays,
        expiringSoon: expiresInDays <= 7,
        scopes: connection.scopes,
        status: expiresInDays <= 0 ? "expired" : connection.status,
        lastError: connection.last_error,
      };
    }),
    adAccounts: accounts.map((account) => ({
      id: account.id,
      connectionId: account.connection_id,
      advertiserId: account.advertiser_id,
      metaAdAccountId: account.meta_ad_account_id,
      name: account.name,
      currency: account.currency,
      timezoneName: account.timezone_name,
      timezoneOffsetHours: account.timezone_offset_hours,
      accountStatus: account.account_status,
      businessName: account.business_name,
      selected: account.selected,
      readiness: account.readiness,
      contentLocale: account.content_locale,
    })),
  });
}
