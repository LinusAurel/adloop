// Delivery-status toggle (#17) — the Human-Gate behind
// POST /api/campaigns/:id/status. Publishes always create PAUSED objects
// (Hard Stop 2); activation is one deliberate human click on the
// admin-guarded route. Rules:
//   - Only IDs our own store knows (campaign of a brand or published ad)
//     are accepted — never arbitrary Graph objects.
//   - Demo IDs (demo-…, #13) never touch the Graph API: store-only update.

import { updateEntityStatus } from "./connectors/meta.ts";
import { readCollection, upsert } from "./store.ts";
import type { DeliveryStatus } from "./types.ts";

export interface StatusToggleResult {
  id: string;
  kind: "campaign" | "ad";
  status: DeliveryStatus;
  // true when the ID is a simulated demo ID — no Graph call happened.
  demo: boolean;
}

export function isDemoMetaId(id: string): boolean {
  return id.startsWith("demo-");
}

export async function setDeliveryStatus(
  id: string,
  status: DeliveryStatus,
): Promise<StatusToggleResult> {
  const demo = isDemoMetaId(id);

  const brand = readCollection("brands").find((b) => b.meta.campaignId === id);
  if (brand) {
    if (!demo) await updateEntityStatus(id, status);
    brand.meta.campaignStatus = status;
    upsert("brands", brand);
    return { id, kind: "campaign", status, demo };
  }

  const asset = readCollection("assets").find((a) => a.metaIds?.adId === id);
  if (asset) {
    if (!demo) await updateEntityStatus(id, status);
    asset.deliveryStatus = status;
    upsert("assets", asset);
    return { id, kind: "ad", status, demo };
  }

  throw new Error("unknown_meta_id");
}
