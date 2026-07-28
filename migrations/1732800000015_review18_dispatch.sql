-- Up Migration
-- Review 18 / Finding 1: mark Meta dispatch before the call so a lost
-- response cannot be retried blindly. Resume reconciles instead.

ALTER TABLE publication_step
  ADD COLUMN dispatched_at timestamptz;

-- Down Migration
-- Forward-only by policy (see DECISIONS.md) — down migrations are not used.
