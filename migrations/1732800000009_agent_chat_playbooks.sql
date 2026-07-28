-- Up Migration
-- Etappe 4: Agent, Chat, Playbooks, Freigaben, Run-Ereignisse.

-- ui_locale / agent_locale on the user (SPEC §8.1; auftrag §0.8).
ALTER TABLE app_user
  ADD COLUMN ui_locale text NOT NULL DEFAULT 'de',
  ADD COLUMN agent_locale text NOT NULL DEFAULT 'de';

ALTER TABLE app_user
  ADD CONSTRAINT app_user_ui_locale_chk
    CHECK (ui_locale IN ('de', 'en')),
  ADD CONSTRAINT app_user_agent_locale_chk
    CHECK (agent_locale IN ('de', 'en'));

-- Queue run.status stays Etappe-1 primitives. Turn phases live beside them
-- so agent turns do not break the job state machine (auftrag §0).
ALTER TABLE run
  ADD COLUMN chat_id uuid,
  ADD COLUMN resolved_input jsonb,
  ADD COLUMN context_packet text,
  ADD COLUMN playbook_version text,
  ADD COLUMN prompt_hash text,
  ADD COLUMN steps jsonb,
  ADD COLUMN turn_phase text;

ALTER TABLE run
  ADD CONSTRAINT run_turn_phase_chk CHECK (
    turn_phase IS NULL OR turn_phase IN (
      'queued', 'claimed', 'assembling_context', 'invoking_model',
      'streaming', 'harvesting_outputs', 'finalizing', 'completed',
      'awaiting_approval', 'failed'
    )
  );

CREATE TABLE project (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  name text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_tenant_idx ON project (tenant_id, created_at DESC);

CREATE TABLE chat (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  project_id uuid REFERENCES project (id) ON DELETE SET NULL,
  name text NOT NULL DEFAULT '',
  summary text,
  archived boolean NOT NULL DEFAULT false,
  pinned boolean NOT NULL DEFAULT false,
  awaiting_clarify boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_tenant_project_idx ON chat (tenant_id, project_id, updated_at DESC);

ALTER TABLE run
  ADD CONSTRAINT run_chat_id_fkey
    FOREIGN KEY (chat_id) REFERENCES chat (id) ON DELETE SET NULL;

CREATE TABLE message (
  id uuid PRIMARY KEY, -- client-assigned (UUIDv7)
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  chat_id uuid NOT NULL REFERENCES chat (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL DEFAULT '',
  tool_invocations jsonb,
  render_artifacts jsonb,
  run_id uuid REFERENCES run (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_chat_idx ON message (chat_id, created_at);

-- Freigabe speichert den aufgelösten Payload wortwörtlich (auftrag §0.1).
CREATE TABLE tool_approval (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  run_id uuid NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  resolved_payload jsonb NOT NULL,
  resolved_request_hash text NOT NULL,
  operation_id uuid NOT NULL,
  cost_estimate text,
  scope jsonb,
  decided_by uuid REFERENCES app_user (id),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id)
);

CREATE INDEX tool_approval_run_idx ON tool_approval (run_id, created_at);

-- Reservierte Operation: Retry referenziert operation_id, nicht die Freigabe.
CREATE TABLE reserved_operation (
  operation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  resolved_request_hash text NOT NULL,
  resolved_payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('in_flight', 'succeeded', 'failed')),
  result jsonb,
  approval_id uuid REFERENCES tool_approval (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Playbook-Override ersetzt ein ganzes Verzeichnis (files jsonb), nicht nur body.
CREATE TABLE playbook_override (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  playbook_slug text NOT NULL,
  version int NOT NULL,
  files jsonb NOT NULL,
  content_hash text NOT NULL,
  author_id uuid REFERENCES app_user (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX playbook_override_active_uniq
  ON playbook_override (tenant_id, playbook_slug)
  WHERE active;

-- Streng monotones Ereignisprotokoll je Run (auftrag §0.3).
CREATE TABLE run_event (
  run_id uuid NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('turn_phase', 'activity', 'delta', 'terminal')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX run_event_run_created_idx ON run_event (run_id, created_at);

-- Seed a default project for the loyft tenant (smoke / verification).
INSERT INTO project (id, tenant_id, name)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  'Default'
)
ON CONFLICT (id) DO NOTHING;

-- Down Migration
-- Forward-only by policy (see DECISIONS.md) — down migrations are not used.
