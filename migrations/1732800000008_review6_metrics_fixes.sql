-- Up Migration
-- Review-6 fixes: is_cumulative key, unique numerator types, append-only
-- assignments (no EXCLUDE that forced UPDATE), account-level windows.

-- Finding 8: cumulative and half-window rows must not share a natural key.
ALTER TABLE insight_window
  DROP CONSTRAINT insight_window_pkey;

ALTER TABLE insight_window
  ADD PRIMARY KEY (
    tenant_id, meta_ad_id, window_start, window_end, is_cumulative, sync_run_id
  );

CREATE OR REPLACE FUNCTION insight_window_as_of(
  p_tenant uuid,
  p_data_as_of timestamptz
)
RETURNS SETOF insight_window
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (
    w.tenant_id,
    w.meta_ad_id,
    w.window_start,
    w.window_end,
    w.is_cumulative
  ) w.*
  FROM insight_window w
  JOIN insight_sync_run r
    ON r.id = w.sync_run_id
   AND r.tenant_id = w.tenant_id
   AND r.status = 'succeeded'
  WHERE w.tenant_id = p_tenant
    AND w.observed_at <= p_data_as_of
    AND r.finished_at <= p_data_as_of
  ORDER BY
    w.tenant_id,
    w.meta_ad_id,
    w.window_start,
    w.window_end,
    w.is_cumulative,
    w.observed_at DESC,
    r.finished_at DESC,
    r.id DESC;
$$;

-- Finding 6: duplicate action types must be rejected at the DB boundary.
-- Order is significant for coalesce_aliases / first_present, so uniqueness
-- only — not the sorted-set canonicalization used for attribution_spec.
CREATE FUNCTION is_unique_text_array(values_to_check text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(values_to_check) = (
    SELECT count(DISTINCT value)::int
    FROM unnest(values_to_check) AS value
  );
$$;

ALTER TABLE conversion_metric
  ADD CONSTRAINT conversion_metric_numerator_action_types_unique CHECK (
    is_unique_text_array(numerator_action_types)
  );

-- Finding 5: assignments are append-only inserts. Overlap exclusion forced an
-- UPDATE to close the prior row; supersession is resolved at read time via
-- created_at <= dataAsOf instead.
ALTER TABLE ad_account_metric_assignment
  DROP CONSTRAINT IF EXISTS ad_account_metric_assignment_meta_ad_account_id_tstzrange_excl;

-- Finding 10: account-level reach/frequency — never summed from ads.
CREATE TABLE insight_account_window (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  meta_ad_account_id uuid NOT NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  reach bigint NOT NULL,
  frequency numeric NOT NULL,
  impressions bigint NOT NULL,
  spend numeric NOT NULL,
  sync_run_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id, meta_ad_account_id, window_start, window_end, sync_run_id
  ),
  FOREIGN KEY (meta_ad_account_id, tenant_id)
    REFERENCES meta_ad_account (id, tenant_id),
  FOREIGN KEY (sync_run_id, tenant_id)
    REFERENCES insight_sync_run (id, tenant_id) ON DELETE CASCADE,
  CHECK (window_start <= window_end)
);

COMMENT ON TABLE insight_account_window IS
  'Append-only account-level Meta window observations. Reach/frequency are non-additive across ads; query Meta at account level and store here.';

CREATE FUNCTION insight_account_window_as_of(
  p_tenant uuid,
  p_data_as_of timestamptz
)
RETURNS SETOF insight_account_window
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (
    w.tenant_id,
    w.meta_ad_account_id,
    w.window_start,
    w.window_end
  ) w.*
  FROM insight_account_window w
  JOIN insight_sync_run r
    ON r.id = w.sync_run_id
   AND r.tenant_id = w.tenant_id
   AND r.status = 'succeeded'
  WHERE w.tenant_id = p_tenant
    AND w.observed_at <= p_data_as_of
    AND r.finished_at <= p_data_as_of
  ORDER BY
    w.tenant_id,
    w.meta_ad_account_id,
    w.window_start,
    w.window_end,
    w.observed_at DESC,
    r.finished_at DESC,
    r.id DESC;
$$;

-- Down Migration
-- Forward-only by policy (see DECISIONS.md).
