-- Up Migration
-- Idempotent seed with fixed IDs: safe to run on every container start
-- (ON CONFLICT DO NOTHING), so restarts never duplicate the seed tenant.

INSERT INTO tenant (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'loyft')
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_user (id, tenant_id, email, role)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'user@example.com',
  'owner'
)
ON CONFLICT (id) DO NOTHING;

-- Down Migration
-- Forward-only by policy (see DECISIONS.md) — down migrations are not used.
