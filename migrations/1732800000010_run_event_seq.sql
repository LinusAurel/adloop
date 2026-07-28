-- Up Migration
-- Atomic per-run event sequence (Review-8 P0-2). Allocated via
-- UPDATE run SET event_seq = event_seq + 1 RETURNING in the same statement
-- as the run_event INSERT so concurrent appends never share a seq.

ALTER TABLE run
  ADD COLUMN IF NOT EXISTS event_seq bigint NOT NULL DEFAULT 0;

UPDATE run r
SET event_seq = COALESCE(
  (SELECT MAX(e.seq) FROM run_event e WHERE e.run_id = r.id),
  0
);

-- Down Migration
-- Forward-only by policy (see DECISIONS.md) — down migrations are not used.
