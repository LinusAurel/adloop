import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import { decryptToken } from "@/meta/token-crypto";
import { MetaGraphClient } from "@/meta/graph-client";
import { MetaWriteClient } from "@/meta/write-client";
import { PublishError } from "@/publish/schemas";
import type { CampaignBudgetReader } from "@/publish/resolve";

/**
 * Build a live Meta write client for a tenant-owned ad account.
 * Shared by the publish Freigabe path and campaign budget lookups.
 */
export async function buildLiveWriteClient(
  tenantId: string,
  metaAdAccountId: string,
): Promise<MetaWriteClient> {
  if (!env.ENCRYPTION_KEY) {
    throw new PublishError("validation_error", { reason: "meta_not_configured" });
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
    throw new PublishError("account_not_found");
  }
  const accessToken = decryptToken(tokenRow.token_encrypted, env.ENCRYPTION_KEY);
  const graph = new MetaGraphClient({
    accessToken,
    apiVersion: env.META_GRAPH_API_VERSION,
  });
  return new MetaWriteClient(graph);
}

export function campaignReaderFromClient(
  client: Pick<MetaWriteClient, "getCampaign">,
): CampaignBudgetReader {
  return {
    async getCampaign(campaignId: string) {
      const row = await client.getCampaign(campaignId);
      return {
        dailyBudget: row.dailyBudget,
        lifetimeBudget: row.lifetimeBudget,
      };
    },
  };
}
