-- Up Migration
-- Brand and product profile: what the copywriting playbooks call "the
-- advertiser's tone, terms and claims from the context packet".

-- Versioned like advertiser_defaults: the latest version wins, older ones stay
-- readable. A brand profile decides what an ad may claim, so the row that was
-- in force when a run produced its copy has to remain reconstructible.
CREATE TABLE advertiser_brand_profile (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  advertiser_id uuid NOT NULL,
  version int NOT NULL CHECK (version >= 1),
  profile jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, advertiser_id, version),
  FOREIGN KEY (advertiser_id, tenant_id)
    REFERENCES advertiser (id, tenant_id)
);

CREATE INDEX advertiser_brand_profile_latest_idx
  ON advertiser_brand_profile (tenant_id, advertiser_id, version DESC);

COMMENT ON COLUMN advertiser_brand_profile.profile IS
  'BrandProfile (src/brand/profile.ts). Supported and unsupported claims are separate lists on purpose: only the supported ones may be stated as fact in generated copy.';

-- Down Migration
-- Forward-only by policy (see DECISIONS.md) — down migrations are not used.
