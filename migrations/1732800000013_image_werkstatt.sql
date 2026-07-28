-- Up Migration
-- Etappe 6: Bild-Werkstatt — Idempotenz, Assets, Creatives, Generierung.

-- Run may escalate to human review when a provider cannot safely recover
-- after a crash (auftrag §0 unprotected).
ALTER TABLE run DROP CONSTRAINT IF EXISTS run_status_check;
ALTER TABLE run ADD CONSTRAINT run_status_check CHECK (
  status IN (
    'queued', 'running', 'completed', 'failed', 'timed_out', 'cancelled',
    'needs_human_check'
  )
);

CREATE TABLE idempotency_key (
  key text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_flight', 'succeeded', 'failed')),
  result jsonb,
  correlation_id uuid NOT NULL,
  provider text,
  provider_job jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX idempotency_key_tenant_idx
  ON idempotency_key (tenant_id, created_at DESC);
CREATE INDEX idempotency_key_correlation_idx
  ON idempotency_key (correlation_id);

CREATE TABLE asset (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  kind text NOT NULL CHECK (kind IN ('image', 'video')),
  storage_key text NOT NULL,
  width int NOT NULL CHECK (width > 0),
  height int NOT NULL CHECK (height > 0),
  mime text NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, storage_key)
);

CREATE INDEX asset_tenant_idx ON asset (tenant_id, created_at DESC);

CREATE TABLE creative_generation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  run_id uuid NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  advertiser_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  inputs jsonb NOT NULL,
  resolved_inputs jsonb NOT NULL,
  provider_request jsonb,
  provider_response jsonb,
  playbook_version text,
  cost_estimate jsonb NOT NULL,
  idempotency_key text NOT NULL REFERENCES idempotency_key (key),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (advertiser_id, tenant_id)
    REFERENCES advertiser (id, tenant_id)
);

CREATE INDEX creative_generation_tenant_idx
  ON creative_generation (tenant_id, created_at DESC);
CREATE INDEX creative_generation_run_idx
  ON creative_generation (run_id);

CREATE TABLE creative (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  advertiser_id uuid NOT NULL,
  name text NOT NULL,
  primary_text text NOT NULL,
  headline text NOT NULL,
  description text NOT NULL DEFAULT '',
  call_to_action text NOT NULL DEFAULT 'LEARN_MORE',
  asset_id uuid NOT NULL REFERENCES asset (id),
  aspect_ratio text NOT NULL,
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'archived', 'needs_human_check')),
  generation_id uuid REFERENCES creative_generation (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (advertiser_id, tenant_id)
    REFERENCES advertiser (id, tenant_id)
);

CREATE INDEX creative_tenant_advertiser_idx
  ON creative (tenant_id, advertiser_id, created_at DESC);
CREATE INDEX creative_aspect_idx
  ON creative (tenant_id, aspect_ratio);

CREATE TABLE creative_variant (
  id uuid PRIMARY KEY,
  parent_creative_id uuid NOT NULL REFERENCES creative (id) ON DELETE CASCADE,
  creative_id uuid NOT NULL REFERENCES creative (id) ON DELETE CASCADE,
  variation_index int NOT NULL CHECK (variation_index >= 0),
  reason text NOT NULL,
  UNIQUE (parent_creative_id, creative_id)
);

CREATE INDEX creative_variant_parent_idx
  ON creative_variant (parent_creative_id);

-- Down Migration
-- Forward-only by policy (see DECISIONS.md) — down migrations are not used.
