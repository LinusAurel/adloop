-- Up Migration
-- Review-10: DB invariant for one active strategist review per ad+type;
-- message/chat carry i18n code+params for system-generated UI strings.

-- Reject a second active strategist review for the same ad and run type at
-- the database boundary (application SELECT FOR UPDATE is not enough under
-- concurrent inserts). Status leaves the partial index on terminal finalize.
CREATE UNIQUE INDEX job_strategist_review_active_ad_idx
  ON job (tenant_id, (input->>'metaAdId'), family)
  WHERE family IN ('copychief_review', 'cro_review', 'variations')
    AND status IN ('queued', 'claimed', 'retry_scheduled', 'cancel_requested');

ALTER TABLE message
  ADD COLUMN content_code text,
  ADD COLUMN content_params jsonb;

COMMENT ON COLUMN message.content_code IS
  'Optional i18n key for system-generated visible text. content stays for model replies and free-form user input.';
COMMENT ON COLUMN message.content_params IS
  'Interpolation params for content_code. Null when content_code is null.';

ALTER TABLE chat
  ADD COLUMN name_code text,
  ADD COLUMN name_params jsonb;

COMMENT ON COLUMN chat.name_code IS
  'Optional i18n key for system-generated chat titles. name may be empty when set.';
COMMENT ON COLUMN chat.name_params IS
  'Interpolation params for name_code. Null when name_code is null.';

-- Down Migration
-- Forward-only by policy (see DECISIONS.md).
