import type { Queryable } from "@/db/queryable";
import { availableImageProviders } from "@/images/registry";
import { metaConfiguration } from "@/meta/oauth";
import type { SetupAccountFacts, SetupFacts } from "./steps";

/**
 * Reads the state of an installation from the data it actually holds.
 *
 * Every question here is answered against the owning table, not against the
 * cached `meta_ad_account.readiness` document: readiness is written by the sync
 * job and would report "ready" for an account whose runs were deleted, and it
 * says nothing at all about metrics or publish defaults.
 */
interface AccountRow {
  id: string;
  name: string;
  has_sync: boolean;
  has_metric: boolean;
  has_defaults: boolean;
}

interface ConnectionRow {
  connections: string;
  usable: string;
}

export async function collectSetupFacts(
  db: Queryable,
  tenantId: string,
): Promise<SetupFacts> {
  const [connections, accounts] = await Promise.all([
    db.query<ConnectionRow>(
      `SELECT
         count(*)::text AS connections,
         count(*) FILTER (WHERE token_expires_at > now())::text AS usable
       FROM meta_connection
       WHERE tenant_id = $1`,
      [tenantId],
    ),
    db.query<AccountRow>(
      `SELECT
         a.id,
         a.name,
         EXISTS (
           SELECT 1 FROM insight_sync_run r
           WHERE r.tenant_id = a.tenant_id
             AND r.meta_ad_account_id = a.id
             AND r.status = 'succeeded'
         ) AS has_sync,
         EXISTS (
           SELECT 1 FROM ad_account_metric_assignment m
           WHERE m.tenant_id = a.tenant_id
             AND m.meta_ad_account_id = a.id
             AND (m.effective_to IS NULL OR m.effective_to > now())
         ) AS has_metric,
         EXISTS (
           SELECT 1 FROM advertiser_defaults d
           WHERE d.tenant_id = a.tenant_id
             AND d.advertiser_id = a.advertiser_id
             AND coalesce(d.settings -> 'identity' ->> 'pageId', '') <> ''
         ) AS has_defaults
       FROM meta_ad_account a
       WHERE a.tenant_id = $1
         AND a.selected
       ORDER BY a.name, a.meta_ad_account_id`,
      [tenantId],
    ),
  ]);

  const selectedAccounts: SetupAccountFacts[] = accounts.rows.map((row) => ({
    id: row.id,
    name: row.name,
    hasSucceededSync: row.has_sync,
    hasAssignedMetric: row.has_metric,
    hasPublishDefaults: row.has_defaults,
  }));

  return {
    metaConfigured: metaConfiguration() !== null,
    connections: Number(connections.rows[0]?.connections ?? 0),
    usableConnections: Number(connections.rows[0]?.usable ?? 0),
    selectedAccounts,
    // The stub is left out deliberately. It is constructible without any key,
    // so counting it would make this step permanently green while the product
    // can only produce placeholder bytes, never an ad image.
    imageProviders: availableImageProviders()
      .filter((provider) => provider.id !== "stub")
      .map((provider) => provider.id),
  };
}
