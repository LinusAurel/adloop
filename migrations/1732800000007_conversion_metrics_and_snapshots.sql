-- Up Migration

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Missing Meta action_values must be distinguishable from a reported zero.
ALTER TABLE insight_action_daily
  ALTER COLUMN value DROP NOT NULL;

COMMENT ON COLUMN insight_action_daily.value IS
  'Meta-reported conversion value. NULL means Meta omitted action_values for this action_type; 0 means a reported zero (including completeness tombstones).';

-- Append-only metric definitions. A new version is a new row with the same id.
-- Snapshots pin (id, version); assignments reference the logical id and resolve
-- the version effective at windowEnd.
CREATE TABLE conversion_metric (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  label text NOT NULL,
  version int NOT NULL CHECK (version >= 1),
  numerator_action_types text[] NOT NULL
    CHECK (cardinality(numerator_action_types) >= 1),
  numerator_aggregation text NOT NULL
    CHECK (numerator_aggregation IN ('sum_disjoint', 'coalesce_aliases', 'first_present')),
  attribution_spec text[] NOT NULL
    CHECK (is_canonical_text_set(attribution_spec) AND cardinality(attribution_spec) >= 1),
  denominator text
    CHECK (
      denominator IS NULL
      OR denominator IN ('impressions', 'clicks', 'link_clicks', 'landing_page_views')
    ),
  value_source text NOT NULL
    CHECK (value_source IN ('meta_value', 'fixed', 'none')),
  fixed_value numeric,
  currency text,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  CHECK (
    (value_source = 'fixed' AND fixed_value IS NOT NULL AND currency IS NOT NULL)
    OR (value_source <> 'fixed' AND fixed_value IS NULL)
  ),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX conversion_metric_tenant_idx
  ON conversion_metric (tenant_id, id, version DESC);

CREATE TABLE ad_account_metric_assignment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  meta_ad_account_id uuid NOT NULL,
  conversion_metric_id uuid NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (meta_ad_account_id, tenant_id)
    REFERENCES meta_ad_account (id, tenant_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (
    meta_ad_account_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

CREATE INDEX ad_account_metric_assignment_account_idx
  ON ad_account_metric_assignment (meta_ad_account_id, effective_from DESC);

CREATE TABLE metric_snapshot (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  subject_type text NOT NULL CHECK (subject_type IN ('account', 'ad')),
  subject_id text NOT NULL,
  meta_ad_account_id uuid NOT NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  data_as_of timestamptz NOT NULL,
  source_sync_run_ids uuid[] NOT NULL,
  formula_version text NOT NULL,
  score_config_version text NOT NULL,
  metric_definition_id uuid,
  metric_definition_version int,
  population_hash text,
  population_size int,
  winsor_bounds jsonb,
  component_means jsonb,
  component_stddevs jsonb,
  inputs jsonb NOT NULL,
  value numeric,
  gate_status text NOT NULL
    CHECK (gate_status IN ('ok', 'insufficient_data')),
  gate_reasons text[] NOT NULL DEFAULT '{}',
  computed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (meta_ad_account_id, tenant_id)
    REFERENCES meta_ad_account (id, tenant_id),
  CHECK (window_start <= window_end)
);

CREATE INDEX metric_snapshot_lookup_idx
  ON metric_snapshot (
    tenant_id, meta_ad_account_id, subject_type, subject_id,
    window_start, window_end, data_as_of DESC, computed_at DESC
  );

COMMENT ON TABLE metric_snapshot IS
  'Append-only derived scores. Never UPDATE; a new sync, metric version, or formula version inserts a new row. Read the newest row for a given data_as_of.';

COMMENT ON COLUMN metric_snapshot.inputs IS
  'Raw inputs used for the score, including accountCurrency for currency-denominated gates such as minSpend.';

-- Down Migration
-- Forward-only by policy (see DECISIONS.md).
