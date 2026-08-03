import { uuidv7 } from "uuidv7";
import type { Queryable } from "@/db/queryable";
import {
  BrandProfileSchema,
  normalizeBrandProfile,
  type BrandProfile,
} from "./profile";

export type BrandProfileErrorCode =
  | "brand_profile_version_conflict"
  | "brand_profile_corrupt";

/** SPEC §8.2: a code plus parameters, never a sentence. */
export class BrandProfileError extends Error {
  constructor(
    readonly code: BrandProfileErrorCode,
    readonly params: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(code);
    this.name = "BrandProfileError";
  }
}

export interface StoredBrandProfile {
  version: number;
  profile: BrandProfile;
}

export async function loadLatestBrandProfile(
  db: Queryable,
  tenantId: string,
  advertiserId: string,
): Promise<StoredBrandProfile | null> {
  const result = await db.query<{ version: number; profile: unknown }>(
    `SELECT version, profile
     FROM advertiser_brand_profile
     WHERE tenant_id = $1 AND advertiser_id = $2
     ORDER BY version DESC
     LIMIT 1`,
    [tenantId, advertiserId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const parsed = BrandProfileSchema.safeParse(row.profile);
  // A row written by an older shape must not silently become a half-profile:
  // the agent would take the missing half for "nothing to say" and fill it in.
  if (!parsed.success) {
    throw new BrandProfileError("brand_profile_corrupt", { advertiserId });
  }
  return { version: row.version, profile: parsed.data };
}

export async function saveBrandProfile(
  db: Queryable,
  params: {
    tenantId: string;
    advertiserId: string;
    profile: BrandProfile;
    createdBy: string;
    /** Optimistic concurrency. `null` expects no prior version. */
    expectedVersion: number | null;
  },
): Promise<{ version: number; id: string; profile: BrandProfile }> {
  const profile = normalizeBrandProfile(BrandProfileSchema.parse(params.profile));
  const previous = await loadLatestBrandProfile(
    db,
    params.tenantId,
    params.advertiserId,
  );
  const current = previous?.version ?? null;
  if (current !== params.expectedVersion) {
    throw new BrandProfileError("brand_profile_version_conflict", {
      expected: params.expectedVersion ?? "null",
      actual: current ?? "null",
    });
  }
  const version = (previous?.version ?? 0) + 1;
  const id = uuidv7();
  await db.query(
    `INSERT INTO advertiser_brand_profile (
       id, tenant_id, advertiser_id, version, profile, created_by
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      id,
      params.tenantId,
      params.advertiserId,
      version,
      JSON.stringify(profile),
      params.createdBy,
    ],
  );
  return { version, id, profile };
}
