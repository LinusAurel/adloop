import { uuidv7 } from "uuidv7";
import type { Pool } from "pg";
import { INSIGHT_QUERY_SIGNATURE } from "@/meta/insight-sync";

const ATTRIBUTION = ["1d_view", "7d_click"];

export interface SeedAccount {
  tenantId: string;
  advertiserId: string;
  connectionId: string;
  accountId: string;
  currency: string;
}

export async function seedMetaAccount(
  pool: Pool,
  tenantId: string,
  currency = "EUR",
): Promise<SeedAccount> {
  const advertiserId = uuidv7();
  const connectionId = uuidv7();
  const accountId = uuidv7();
  await pool.query(
    `INSERT INTO advertiser (id, tenant_id, name, content_locale)
     VALUES ($1, $2, 'Synthetic advertiser', 'de-DE')`,
    [advertiserId, tenantId],
  );
  await pool.query(
    `INSERT INTO meta_connection (
       id, tenant_id, meta_user_id, token_encrypted, token_expires_at,
       scopes, status
     ) VALUES (
       $1, $2, $3, 'encrypted-fixture',
       now() + interval '60 days',
       ARRAY['ads_read'], 'ready'
     )`,
    [connectionId, tenantId, `user-${connectionId.replace(/-/g, "").slice(0, 15)}`],
  );
  await pool.query(
    `INSERT INTO meta_ad_account (
       id, tenant_id, connection_id, advertiser_id, meta_ad_account_id,
       name, currency, timezone_name, timezone_offset_hours,
       account_status, selected, readiness
     ) VALUES (
       $1, $2, $3, $4, $5, 'Synthetic account', $6,
       'Europe/Berlin', 2, 1, true, '{}'::jsonb
     )`,
    [
      accountId,
      tenantId,
      connectionId,
      advertiserId,
      `act_${accountId.replace(/-/g, "").slice(0, 15)}`,
      currency,
    ],
  );
  return { tenantId, advertiserId, connectionId, accountId, currency };
}

export async function seedSucceededSync(
  pool: Pool,
  params: {
    tenantId: string;
    accountId: string;
    windowStart: string;
    windowEnd: string;
    finishedAt?: Date;
  },
): Promise<string> {
  const syncRunId = uuidv7();
  const finishedAt = params.finishedAt ?? new Date("2026-07-20T12:00:00.000Z");
  await pool.query(
    `INSERT INTO insight_sync_run (
       id, tenant_id, meta_ad_account_id, api_version, query_signature,
       window_start, window_end, account_timezone, status,
       started_at, finished_at
     ) VALUES (
       $1, $2, $3, 'v22.0', $4, $5::date, $6::date, 'Europe/Berlin',
       'succeeded', $7, $7
     )`,
    [
      syncRunId,
      params.tenantId,
      params.accountId,
      INSIGHT_QUERY_SIGNATURE,
      params.windowStart,
      params.windowEnd,
      finishedAt.toISOString(),
    ],
  );
  return syncRunId;
}

export interface SeedAdDay {
  metaAdId: string;
  date: string;
  spend?: number;
  impressions?: number;
  clicks?: number;
  linkClicks?: number;
  landingPageViews?: number;
  reach?: number;
  frequency?: number;
  actions?: Array<{
    actionType: string;
    count: number;
    value?: number | null;
  }>;
}

export async function seedDailyRows(
  pool: Pool,
  params: {
    tenantId: string;
    syncRunId: string;
    rows: SeedAdDay[];
    observedAt?: Date;
  },
): Promise<void> {
  const observedAt = (
    params.observedAt ?? new Date("2026-07-10T12:00:00.000Z")
  ).toISOString();
  for (const row of params.rows) {
    await pool.query(
      `INSERT INTO insight_daily (
         tenant_id, meta_ad_id, date, spend, impressions, clicks,
         link_clicks, landing_page_views, reach, frequency,
         video_plays, video_p25, video_p50, video_p75, video_p95, video_p100,
         thruplays, avg_seconds_watched, sync_run_id, observed_at
       ) VALUES (
         $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10,
         0, 0, 0, 0, 0, 0, 0, 0, $11, $12
       )`,
      [
        params.tenantId,
        row.metaAdId,
        row.date,
        row.spend ?? 0,
        row.impressions ?? 0,
        row.clicks ?? 0,
        row.linkClicks ?? 0,
        row.landingPageViews ?? 0,
        row.reach ?? 0,
        row.frequency ?? 0,
        params.syncRunId,
        observedAt,
      ],
    );
    for (const action of row.actions ?? []) {
      await pool.query(
        `INSERT INTO insight_action_daily (
           tenant_id, meta_ad_id, date, action_type, attribution_spec,
           count, value, sync_run_id, observed_at
         ) VALUES (
           $1, $2, $3::date, $4, $5::text[], $6, $7, $8, $9
         )`,
        [
          params.tenantId,
          row.metaAdId,
          row.date,
          action.actionType,
          ATTRIBUTION,
          action.count,
          action.value === undefined ? 0 : action.value,
          params.syncRunId,
          observedAt,
        ],
      );
    }
  }
}

export async function seedWindow(
  pool: Pool,
  params: {
    tenantId: string;
    syncRunId: string;
    metaAdId: string;
    windowStart: string;
    windowEnd: string;
    reach: number;
    frequency: number;
    impressions?: number;
    spend?: number;
    isCumulative?: boolean;
    observedAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO insight_window (
       tenant_id, meta_ad_id, window_start, window_end,
       reach, frequency, impressions, spend, is_cumulative,
       sync_run_id, observed_at
     ) VALUES (
       $1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11
     )`,
    [
      params.tenantId,
      params.metaAdId,
      params.windowStart,
      params.windowEnd,
      params.reach,
      params.frequency,
      params.impressions ?? 0,
      params.spend ?? 0,
      params.isCumulative ?? false,
      params.syncRunId,
      (params.observedAt ?? new Date("2026-07-10T12:00:00.000Z")).toISOString(),
    ],
  );
}

/** Build a 30-day population that passes the data gate for funnel scoring. */
export function buildPassingPopulation(options?: {
  size?: number;
  windowStart?: string;
  windowEnd?: string;
  netNewReachByIndex?: (index: number) => number;
  conversionsByIndex?: (index: number) => number;
  valueByIndex?: (index: number) => number;
}): {
  windowStart: string;
  windowEnd: string;
  ads: Array<{
    metaAdId: string;
    spend: number;
    impressions: number;
    linkClicks: number;
    conversions: number;
    value: number;
    windowReach: number;
    frequency: number;
    netNewReach: number;
    deliveryStart: string;
  }>;
} {
  const size = options?.size ?? 8;
  const windowEnd = options?.windowEnd ?? "2026-07-19";
  const windowStart = options?.windowStart ?? "2026-06-20";
  const ads = Array.from({ length: size }, (_, index) => {
    const metaAdId = `10000000000000${index}`;
    return {
      metaAdId,
      spend: 80 + index * 5,
      impressions: 2000 + index * 100,
      linkClicks: 100 + index * 10,
      conversions: options?.conversionsByIndex?.(index) ?? index,
      value: options?.valueByIndex?.(index) ?? index * 40,
      windowReach: 1500 + index * 50,
      frequency: 1.2 + index * 0.05,
      netNewReach: options?.netNewReachByIndex?.(index) ?? 400 + index * 30,
      deliveryStart: "2026-01-01",
    };
  });
  return { windowStart, windowEnd, ads };
}

export async function seedFunnelPopulation(
  pool: Pool,
  account: SeedAccount,
  population: ReturnType<typeof buildPassingPopulation>,
  syncRunId: string,
  observedAt = new Date("2026-07-10T12:00:00.000Z"),
): Promise<void> {
  const { windowStart, windowEnd, ads } = population;
  const start = new Date(`${windowStart}T00:00:00.000Z`);
  const end = new Date(`${windowEnd}T00:00:00.000Z`);
  const dayCount =
    Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

  for (const ad of ads) {
    // Gapless daily coverage: zero rows for every day, totals on windowEnd so
    // window sums stay equal to the designed population values.
    const dailyRows: SeedAdDay[] = [];
    for (let offset = 0; offset < dayCount; offset += 1) {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() + offset);
      const date = day.toISOString().slice(0, 10);
      if (date === windowEnd) {
        dailyRows.push({
          metaAdId: ad.metaAdId,
          date,
          spend: ad.spend,
          impressions: ad.impressions,
          clicks: ad.linkClicks + 10,
          linkClicks: ad.linkClicks,
          landingPageViews: Math.floor(ad.linkClicks * 0.7),
          reach: ad.windowReach,
          frequency: ad.frequency,
          actions: [
            {
              actionType: "offsite_conversion.fb_pixel_purchase",
              count: ad.conversions,
              value: ad.value,
            },
          ],
        });
      } else {
        dailyRows.push({
          metaAdId: ad.metaAdId,
          date,
          spend: 0,
          impressions: 0,
          clicks: 0,
          linkClicks: 0,
          landingPageViews: 0,
          reach: 0,
          frequency: 0,
        });
      }
    }
    await seedDailyRows(pool, {
      tenantId: account.tenantId,
      syncRunId,
      observedAt,
      rows: dailyRows,
    });
    await seedWindow(pool, {
      tenantId: account.tenantId,
      syncRunId,
      metaAdId: ad.metaAdId,
      windowStart,
      windowEnd,
      reach: ad.windowReach,
      frequency: ad.frequency,
      impressions: ad.impressions,
      spend: ad.spend,
      observedAt,
    });
    // Cumulative end and before-start for net_new_reach.
    await seedWindow(pool, {
      tenantId: account.tenantId,
      syncRunId,
      metaAdId: ad.metaAdId,
      windowStart: ad.deliveryStart,
      windowEnd,
      reach: ad.windowReach + 5000,
      frequency: 2,
      isCumulative: true,
      observedAt,
    });
    const beforeEnd = new Date(`${windowStart}T00:00:00.000Z`);
    beforeEnd.setUTCDate(beforeEnd.getUTCDate() - 1);
    const before = beforeEnd.toISOString().slice(0, 10);
    await seedWindow(pool, {
      tenantId: account.tenantId,
      syncRunId,
      metaAdId: ad.metaAdId,
      windowStart: ad.deliveryStart,
      windowEnd: before,
      reach: ad.windowReach + 5000 - ad.netNewReach,
      frequency: 1.5,
      isCumulative: true,
      observedAt,
    });
  }
}

export async function seedAccountWindow(
  pool: Pool,
  params: {
    tenantId: string;
    accountId: string;
    syncRunId: string;
    windowStart: string;
    windowEnd: string;
    reach: number;
    frequency: number;
    impressions?: number;
    spend?: number;
    observedAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO insight_account_window (
       tenant_id, meta_ad_account_id, window_start, window_end,
       reach, frequency, impressions, spend, sync_run_id, observed_at
     ) VALUES (
       $1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10
     )`,
    [
      params.tenantId,
      params.accountId,
      params.windowStart,
      params.windowEnd,
      params.reach,
      params.frequency,
      params.impressions ?? 0,
      params.spend ?? 0,
      params.syncRunId,
      (params.observedAt ?? new Date("2026-07-10T12:00:00.000Z")).toISOString(),
    ],
  );
}

export async function seedMetaAd(
  pool: Pool,
  params: {
    tenantId: string;
    accountId: string;
    syncRunId: string;
    metaAdId: string;
    name: string;
    status?: string;
    effectiveStatus?: string;
    campaignId?: string;
    adsetId?: string;
    observedAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO meta_ad (
       tenant_id, meta_ad_id, meta_ad_account_id,
       name, status, effective_status,
       meta_campaign_id, meta_adset_id,
       sync_run_id, observed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
     )`,
    [
      params.tenantId,
      params.metaAdId,
      params.accountId,
      params.name,
      params.status ?? "ACTIVE",
      params.effectiveStatus ?? "ACTIVE",
      params.campaignId ?? "200000000000001",
      params.adsetId ?? "300000000000001",
      params.syncRunId,
      (params.observedAt ?? new Date("2026-07-10T12:00:00.000Z")).toISOString(),
    ],
  );
}

/** Make metric/assignment rows known at a historical dataAsOf. */
export async function backdateMetricCreatedAt(
  pool: Pool,
  params: {
    metricIds: string[];
    metaAdAccountId?: string;
    createdAt: string;
  },
): Promise<void> {
  await pool.query(
    `UPDATE conversion_metric SET created_at = $1::timestamptz WHERE id = ANY($2::uuid[])`,
    [params.createdAt, params.metricIds],
  );
  if (params.metaAdAccountId) {
    await pool.query(
      `UPDATE ad_account_metric_assignment
       SET created_at = $1::timestamptz
       WHERE meta_ad_account_id = $2
         AND conversion_metric_id = ANY($3::uuid[])`,
      [params.createdAt, params.metaAdAccountId, params.metricIds],
    );
  }
}
