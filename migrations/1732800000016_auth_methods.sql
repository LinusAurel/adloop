-- Anmeldung ohne Mailversand.
--
-- Der Einmalcode per Mail setzte voraus, dass jeder Betreiber Mailversand hat.
-- Das trägt nicht: adloop soll von fremden Unternehmen selbst betrieben werden,
-- und niemand richtet einen Mailserver ein, um sich anzumelden.
--
-- Drei Wege lösen das ab (SPEC-Nachtrag): ein Konto aus Umgebungsvariablen für
-- den Einzelbetrieb, Passwörter in dieser Tabelle für kleine Teams, OIDC gegen
-- einen vorhandenen Identitätsanbieter für alle anderen.

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS password_hash text,
  -- Woher dieses Konto stammt. Ein über OIDC angelegtes Konto hat kein
  -- Passwort und darf auch keines bekommen, ohne dass es jemand entscheidet.
  ADD COLUMN IF NOT EXISTS auth_source text NOT NULL DEFAULT 'local',
  -- Stabile Kennung beim Identitätsanbieter. Die Mailadresse taugt nicht dafür:
  -- sie ändert sich, wenn jemand heiratet oder die Firma umbenannt wird.
  ADD COLUMN IF NOT EXISTS oidc_subject text;

ALTER TABLE app_user
  DROP CONSTRAINT IF EXISTS app_user_auth_source_chk;

ALTER TABLE app_user
  ADD CONSTRAINT app_user_auth_source_chk
    CHECK (auth_source IN ('local', 'oidc'));

-- Ein Subject gehört zu genau einem Konto. Zwei Konten mit derselben Kennung
-- wären zwei Identitäten für einen Menschen.
CREATE UNIQUE INDEX IF NOT EXISTS app_user_oidc_subject_idx
  ON app_user (oidc_subject)
  WHERE oidc_subject IS NOT NULL;

-- Das Umgebungskonto steht bewusst *nicht* in dieser Tabelle: es soll ohne
-- Datenbankschreibzugriff funktionieren. Damit Fremdschlüssel auf app_user
-- trotzdem greifen, gibt es diesen Platzhalter mit fester Kennung.
INSERT INTO app_user (id, tenant_id, email, role, auth_source)
VALUES (
  '00000000-0000-0000-0000-0000000000e0',
  '00000000-0000-0000-0000-000000000001',
  'env-account@localhost',
  'owner',
  'local'
)
ON CONFLICT (id) DO NOTHING;
