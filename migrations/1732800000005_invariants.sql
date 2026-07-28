-- Up Migration
-- P2-3 (second adversarial review): schema invariants that were previously
-- only enforced by application code discipline.

ALTER TABLE job ADD CONSTRAINT job_attempts_non_negative CHECK (attempts >= 0);

-- Lease fields (lease_token, lease_expires_at) are required exactly while a
-- job is 'claimed' or 'cancel_requested', and forbidden otherwise. Scoped to
-- these two columns only — claimed_by is documented (§3) as diagnostic-only
-- and is deliberately left set after a terminal write for post-mortem
-- debugging, so it is not part of this invariant.
ALTER TABLE job ADD CONSTRAINT job_lease_token_matches_status
  CHECK ((status IN ('claimed', 'cancel_requested')) = (lease_token IS NOT NULL));

ALTER TABLE job ADD CONSTRAINT job_lease_expires_at_matches_status
  CHECK ((status IN ('claimed', 'cancel_requested')) = (lease_expires_at IS NOT NULL));

-- Tenant consistency between job and its run: a composite FK (in addition
-- to the existing job.run_id -> run.id FK) guarantees job.tenant_id can
-- never diverge from the owning run's tenant_id.
ALTER TABLE run ADD CONSTRAINT run_id_tenant_id_unique UNIQUE (id, tenant_id);

ALTER TABLE job ADD CONSTRAINT job_tenant_matches_run
  FOREIGN KEY (run_id, tenant_id) REFERENCES run (id, tenant_id);

ALTER TABLE job_dead_letter ADD CONSTRAINT job_dead_letter_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenant (id);

-- A job is only ever dead-lettered once (fenced by the shared status = 'claimed'
-- precondition on every path that can write it — see sql/finalize.ts and
-- sql/reap.ts), but this makes that guarantee a schema fact, not just an
-- application-code assumption.
ALTER TABLE job_dead_letter ADD CONSTRAINT job_dead_letter_job_id_unique UNIQUE (job_id);

-- Down Migration
-- Forward-only by policy (see DECISIONS.md).
