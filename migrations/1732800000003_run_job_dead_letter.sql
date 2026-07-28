-- Up Migration

CREATE TABLE run (
  id uuid PRIMARY KEY, -- client-assigned (UUIDv7), see §5 idempotency contract
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  kind text NOT NULL, -- the job family name for this run's (single, in Etappe 1) job
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'timed_out', 'cancelled')
  ),
  input jsonb NOT NULL, -- the original request
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX run_tenant_idx ON run (tenant_id, created_at DESC);

CREATE TABLE job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  run_id uuid NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  family text NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'queued', 'claimed', 'retry_scheduled', 'cancel_requested',
      'completed', 'failed', 'timed_out', 'cancelled'
    )
  ),
  input jsonb NOT NULL, -- validated handler input
  attempts int NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  claimed_by text,
  progress jsonb,
  error jsonb,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Etappe 1: exactly one job per run (auftrag §3). A later stage that
  -- allows multiple jobs per run drops this constraint in a new forward
  -- migration — see DECISIONS.md.
  UNIQUE (run_id)
);

-- §3 required index for the claim query (sql/claim.ts).
CREATE INDEX job_claimable_idx ON job (scheduled_for, created_at)
  WHERE status IN ('queued', 'retry_scheduled');

-- Backstop for orphaned leases (sql/reap.ts runs each poll iteration, but a
-- direct index keeps that cheap even before it does).
CREATE INDEX job_lease_expiry_idx ON job (lease_expires_at)
  WHERE status IN ('claimed', 'cancel_requested');

CREATE TABLE job_dead_letter (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  family text,
  input jsonb,
  error jsonb,
  attempts int,
  moved_at timestamptz NOT NULL DEFAULT now()
);

-- §4.9: NOTIFY job_available whenever a job becomes claimable, so the
-- worker's LISTEN wakes up instead of waiting for the next poll interval.
CREATE OR REPLACE FUNCTION notify_job_available() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('queued', 'retry_scheduled') THEN
    PERFORM pg_notify('job_available', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_notify_available_insert
  AFTER INSERT ON job
  FOR EACH ROW
  EXECUTE FUNCTION notify_job_available();

CREATE TRIGGER job_notify_available_update
  AFTER UPDATE OF status ON job
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION notify_job_available();

-- Down Migration
-- Forward-only by policy (see DECISIONS.md) — down migrations are not used.
