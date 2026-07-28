-- Up Migration
-- Etappe 7: Launch — Vorgaben, metric binding, publication step chain with lease.

-- Versioned advertiser defaults (schematized Meta settings). Latest version wins.
CREATE TABLE advertiser_defaults (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  advertiser_id uuid NOT NULL,
  version int NOT NULL CHECK (version >= 1),
  settings jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, advertiser_id, version),
  FOREIGN KEY (advertiser_id, tenant_id)
    REFERENCES advertiser (id, tenant_id)
);

CREATE INDEX advertiser_defaults_latest_idx
  ON advertiser_defaults (tenant_id, advertiser_id, version DESC);

-- Binds a conversion metric version to Meta optimization goal + promoted_object.
-- Active binding is unique per (tenant, conversion_metric_id).
CREATE TABLE metric_optimization_binding (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  conversion_metric_id uuid NOT NULL,
  conversion_metric_version int NOT NULL CHECK (conversion_metric_version >= 1),
  optimization_goal text NOT NULL,
  promoted_object jsonb NOT NULL,
  attribution_spec text[] NOT NULL
    CHECK (cardinality(attribution_spec) >= 1),
  version int NOT NULL CHECK (version >= 1),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversion_metric_id, conversion_metric_version)
    REFERENCES conversion_metric (id, version)
);

CREATE UNIQUE INDEX metric_optimization_binding_active_uidx
  ON metric_optimization_binding (tenant_id, conversion_metric_id)
  WHERE active;

CREATE INDEX metric_optimization_binding_tenant_idx
  ON metric_optimization_binding (tenant_id, conversion_metric_id, version DESC);

CREATE TABLE publication (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  advertiser_id uuid NOT NULL,
  meta_ad_account_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES run (id),
  idempotency_key text NOT NULL,
  status text NOT NULL
    CHECK (status IN (
      'pending', 'in_progress', 'succeeded', 'failed', 'needs_human_review'
    )),
  binding_id uuid REFERENCES metric_optimization_binding (id),
  binding_version int,
  deviation_reason text,
  budget_source jsonb,
  resolved_payload jsonb NOT NULL,
  approval_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (advertiser_id, tenant_id)
    REFERENCES advertiser (id, tenant_id),
  FOREIGN KEY (meta_ad_account_id, tenant_id)
    REFERENCES meta_ad_account (id, tenant_id)
);

CREATE INDEX publication_tenant_idx
  ON publication (tenant_id, created_at DESC);
CREATE INDEX publication_run_idx
  ON publication (run_id);

CREATE TABLE publication_step (
  id uuid PRIMARY KEY,
  publication_id uuid NOT NULL REFERENCES publication (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  step_index int NOT NULL CHECK (step_index >= 0),
  operation text NOT NULL
    CHECK (operation IN (
      'create_campaign', 'create_adset', 'create_creative', 'create_ad'
    )),
  request_hash text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed')),
  external_id text,
  attempt int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_expires_at timestamptz,
  reconcile_state text NOT NULL DEFAULT 'none'
    CHECK (reconcile_state IN (
      'none', 'pending', 'resolved', 'needs_human_review'
    )),
  external_correlation text NOT NULL,
  object_name text NOT NULL,
  error jsonb,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_id, step_index)
);

CREATE INDEX publication_step_pub_idx
  ON publication_step (publication_id, step_index);
CREATE INDEX publication_step_inflight_idx
  ON publication_step (status, lease_expires_at)
  WHERE status = 'in_flight';
CREATE INDEX publication_step_correlation_idx
  ON publication_step (tenant_id, external_correlation);

-- Down Migration
-- Forward-only by policy (see DECISIONS.md) — down migrations are not used.
