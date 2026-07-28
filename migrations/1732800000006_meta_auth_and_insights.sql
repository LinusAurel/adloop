-- Up Migration

CREATE TABLE advertiser (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  name text NOT NULL,
  content_locale text NOT NULL DEFAULT 'de-DE'
    CHECK (content_locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE login_code (
  id uuid PRIMARY KEY,
  app_user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_code_user_created_idx
  ON login_code (app_user_id, created_at DESC);

CREATE TABLE meta_oauth_state (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  app_user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meta_connection (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  meta_user_id text NOT NULL,
  token_encrypted text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'expired', 'error', 'disconnected')),
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, meta_user_id)
);

CREATE TABLE meta_ad_account (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  connection_id uuid NOT NULL,
  advertiser_id uuid NOT NULL,
  meta_ad_account_id text NOT NULL,
  name text NOT NULL,
  currency text NOT NULL,
  timezone_name text NOT NULL,
  timezone_offset_hours numeric NOT NULL,
  account_status int NOT NULL,
  business_name text,
  selected boolean NOT NULL DEFAULT false,
  readiness jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, meta_ad_account_id),
  FOREIGN KEY (connection_id, tenant_id)
    REFERENCES meta_connection (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (advertiser_id, tenant_id)
    REFERENCES advertiser (id, tenant_id)
);

CREATE INDEX meta_ad_account_connection_idx
  ON meta_ad_account (connection_id);

CREATE TABLE insight_sync_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  meta_ad_account_id uuid NOT NULL,
  api_version text NOT NULL,
  query_signature text NOT NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  account_timezone text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'partial', 'succeeded', 'failed', 'cancelled')),
  raw_response_key text,
  pages_fetched int NOT NULL DEFAULT 0 CHECK (pages_fetched >= 0),
  last_cursor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (meta_ad_account_id, tenant_id)
    REFERENCES meta_ad_account (id, tenant_id),
  UNIQUE (id, tenant_id)
);

CREATE INDEX insight_sync_run_account_started_idx
  ON insight_sync_run (tenant_id, meta_ad_account_id, started_at DESC);

-- Durable page checkpoints let a retry continue the same sync observation
-- after a worker crash without silently omitting already-fetched pages.
CREATE TABLE insight_sync_page (
  sync_run_id uuid NOT NULL REFERENCES insight_sync_run (id) ON DELETE CASCADE,
  page_number int NOT NULL CHECK (page_number > 0),
  request_cursor text,
  next_cursor text,
  raw_response jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (sync_run_id, page_number)
);

CREATE TABLE insight_daily (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  meta_ad_id text NOT NULL,
  date date NOT NULL,
  spend numeric NOT NULL,
  impressions bigint NOT NULL,
  clicks bigint NOT NULL,
  link_clicks bigint NOT NULL,
  landing_page_views bigint NOT NULL,
  reach bigint NOT NULL,
  frequency numeric NOT NULL,
  video_plays bigint NOT NULL,
  video_p25 bigint NOT NULL,
  video_p50 bigint NOT NULL,
  video_p75 bigint NOT NULL,
  video_p95 bigint NOT NULL,
  video_p100 bigint NOT NULL,
  thruplays bigint NOT NULL,
  avg_seconds_watched numeric NOT NULL,
  sync_run_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, meta_ad_id, date, sync_run_id),
  FOREIGN KEY (sync_run_id, tenant_id)
    REFERENCES insight_sync_run (id, tenant_id) ON DELETE CASCADE
);

COMMENT ON TABLE insight_daily IS
  'Append-only observations. Never aggregate this table directly; use insight_daily_current or insight_daily_as_of(). Reach is non-additive across dates.';

CREATE FUNCTION is_canonical_text_set(values_to_check text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT values_to_check = ARRAY(
    SELECT DISTINCT value
    FROM unnest(values_to_check) AS value
    ORDER BY value
  );
$$;

CREATE TABLE insight_action_daily (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  meta_ad_id text NOT NULL,
  date date NOT NULL,
  action_type text NOT NULL,
  attribution_spec text[] NOT NULL,
  count numeric NOT NULL,
  value numeric NOT NULL,
  sync_run_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id, meta_ad_id, date, action_type, attribution_spec, sync_run_id
  ),
  FOREIGN KEY (sync_run_id, tenant_id)
    REFERENCES insight_sync_run (id, tenant_id) ON DELETE CASCADE,
  CHECK (is_canonical_text_set(attribution_spec))
);

COMMENT ON TABLE insight_action_daily IS
  'Append-only observations. Never sum this table directly; use insight_action_daily_current or insight_action_daily_as_of() to avoid counting every backfill again.';

CREATE TABLE insight_window (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  meta_ad_id text NOT NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  reach bigint NOT NULL,
  frequency numeric NOT NULL,
  impressions bigint NOT NULL,
  spend numeric NOT NULL,
  is_cumulative boolean NOT NULL,
  sync_run_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id, meta_ad_id, window_start, window_end, sync_run_id
  ),
  FOREIGN KEY (sync_run_id, tenant_id)
    REFERENCES insight_sync_run (id, tenant_id) ON DELETE CASCADE,
  CHECK (window_start <= window_end)
);

COMMENT ON TABLE insight_window IS
  'Append-only observations of individually queried Meta windows. Reach is non-additive: never sum reach across dates or windows; use exact windows and cumulative differences.';

CREATE FUNCTION insight_daily_as_of(
  p_tenant uuid,
  p_data_as_of timestamptz
)
RETURNS SETOF insight_daily
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (d.tenant_id, d.meta_ad_id, d.date) d.*
  FROM insight_daily d
  JOIN insight_sync_run r
    ON r.id = d.sync_run_id
   AND r.tenant_id = d.tenant_id
   AND r.status = 'succeeded'
  WHERE d.tenant_id = p_tenant
    AND d.observed_at <= p_data_as_of
    AND r.finished_at <= p_data_as_of
  ORDER BY
    d.tenant_id,
    d.meta_ad_id,
    d.date,
    d.observed_at DESC,
    r.finished_at DESC,
    r.id DESC;
$$;

CREATE FUNCTION insight_action_daily_as_of(
  p_tenant uuid,
  p_data_as_of timestamptz
)
RETURNS SETOF insight_action_daily
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (
    a.tenant_id,
    a.meta_ad_id,
    a.date,
    a.action_type,
    a.attribution_spec
  ) a.*
  FROM insight_action_daily a
  JOIN insight_sync_run r
    ON r.id = a.sync_run_id
   AND r.tenant_id = a.tenant_id
   AND r.status = 'succeeded'
  WHERE a.tenant_id = p_tenant
    AND a.observed_at <= p_data_as_of
    AND r.finished_at <= p_data_as_of
  ORDER BY
    a.tenant_id,
    a.meta_ad_id,
    a.date,
    a.action_type,
    a.attribution_spec,
    a.observed_at DESC,
    r.finished_at DESC,
    r.id DESC;
$$;

CREATE FUNCTION insight_window_as_of(
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
    w.window_end
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
    w.observed_at DESC,
    r.finished_at DESC,
    r.id DESC;
$$;

CREATE FUNCTION net_new_reach_as_of(
  p_tenant uuid,
  p_meta_ad_id text,
  p_window_start date,
  p_window_end date,
  p_data_as_of timestamptz
)
RETURNS TABLE (
  status text,
  reason text,
  net_new_reach bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH cumulative_end AS (
    SELECT w.*
    FROM insight_window_as_of(p_tenant, p_data_as_of) w
    WHERE w.meta_ad_id = p_meta_ad_id
      AND w.is_cumulative
      AND w.window_end = p_window_end
    ORDER BY w.observed_at DESC
    LIMIT 1
  ),
  cumulative_before AS (
    SELECT w.*
    FROM insight_window_as_of(p_tenant, p_data_as_of) w
    JOIN cumulative_end e ON e.window_start = w.window_start
    WHERE w.meta_ad_id = p_meta_ad_id
      AND w.is_cumulative
      AND w.window_end = p_window_start - 1
    ORDER BY w.observed_at DESC
    LIMIT 1
  )
  SELECT
    CASE
      WHEN e.reach IS NULL THEN 'insufficient_data'
      WHEN p_window_start > e.window_start AND b.reach IS NULL
        THEN 'insufficient_data'
      ELSE 'available'
    END,
    CASE
      WHEN e.reach IS NULL
        OR (p_window_start > e.window_start AND b.reach IS NULL)
        THEN 'cumulative_reach_missing'
      ELSE NULL
    END,
    CASE
      WHEN e.reach IS NULL
        OR (p_window_start > e.window_start AND b.reach IS NULL)
        THEN NULL
      ELSE e.reach - COALESCE(b.reach, 0)
    END
  FROM (SELECT 1) singleton
  LEFT JOIN cumulative_end e ON true
  LEFT JOIN cumulative_before b ON true;
$$;

CREATE VIEW insight_daily_current AS
  SELECT current_row.*
  FROM tenant t
  CROSS JOIN LATERAL insight_daily_as_of(t.id, now()) current_row;

CREATE VIEW insight_action_daily_current AS
  SELECT current_row.*
  FROM tenant t
  CROSS JOIN LATERAL insight_action_daily_as_of(t.id, now()) current_row;

CREATE VIEW insight_window_current AS
  SELECT current_row.*
  FROM tenant t
  CROSS JOIN LATERAL insight_window_as_of(t.id, now()) current_row;

-- Reject a second active sync for the same internal ad-account id at the
-- database boundary, including jobs claimed by distinct worker processes.
CREATE UNIQUE INDEX job_meta_sync_active_account_idx
  ON job ((input->>'metaAdAccountId'))
  WHERE family = 'meta_insight_sync'
    AND status IN ('queued', 'claimed', 'retry_scheduled', 'cancel_requested');

INSERT INTO advertiser (id, tenant_id, name, content_locale)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000001',
  'Default advertiser',
  'de-DE'
)
ON CONFLICT (id) DO NOTHING;

-- Down Migration
-- Forward-only by policy (see DECISIONS.md).
