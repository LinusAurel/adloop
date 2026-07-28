-- Up Migration
-- Etappe 5: ad master data (append-only) + creative_strategy_run mapping table.

CREATE TABLE meta_ad (
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  meta_ad_id text NOT NULL,
  meta_ad_account_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  effective_status text NOT NULL,
  meta_campaign_id text,
  meta_adset_id text,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sync_run_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, meta_ad_id, sync_run_id),
  FOREIGN KEY (meta_ad_account_id, tenant_id)
    REFERENCES meta_ad_account (id, tenant_id),
  FOREIGN KEY (sync_run_id) REFERENCES insight_sync_run (id) ON DELETE CASCADE
);

CREATE INDEX meta_ad_account_idx
  ON meta_ad (tenant_id, meta_ad_account_id, observed_at DESC);

COMMENT ON TABLE meta_ad IS
  'Append-only Meta ad master data (name, status, hierarchy). Read via meta_ad_as_of — never the raw table alone.';

CREATE FUNCTION meta_ad_as_of(
  p_tenant uuid,
  p_data_as_of timestamptz
)
RETURNS SETOF meta_ad
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (a.tenant_id, a.meta_ad_id) a.*
  FROM meta_ad a
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
    a.observed_at DESC,
    r.finished_at DESC,
    r.id DESC;
$$;

CREATE VIEW meta_ad_current AS
SELECT a.*
FROM tenant t
CROSS JOIN LATERAL meta_ad_as_of(t.id, now()) a;

CREATE TABLE creative_strategy_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  run_id uuid NOT NULL REFERENCES run (id),
  chat_id uuid NOT NULL,
  meta_ad_id text NOT NULL,
  meta_ad_account_id uuid NOT NULL,
  run_type text NOT NULL
    CHECK (run_type IN ('copychief_review', 'cro_review', 'variations')),
  title text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id),
  FOREIGN KEY (chat_id) REFERENCES chat (id),
  FOREIGN KEY (meta_ad_account_id, tenant_id)
    REFERENCES meta_ad_account (id, tenant_id)
);

CREATE INDEX creative_strategy_run_ad_idx
  ON creative_strategy_run (tenant_id, meta_ad_id, run_type, created_at DESC);

CREATE INDEX creative_strategy_run_chat_idx
  ON creative_strategy_run (tenant_id, chat_id);

COMMENT ON TABLE creative_strategy_run IS
  'Mapping from a generic run/chat to a strategist ad-review. Job, context_packet, prompt_hash and idempotency live on run — not here.';

-- Down Migration
-- Forward-only by policy (see DECISIONS.md).
