-- Append-only audit trail for privileged actions (role changes). actor_user_id has no
-- foreign key on purpose: the log must survive deletion of the user. Triggers reject
-- UPDATE, DELETE and TRUNCATE so rows can only be added.

CREATE TABLE IF NOT EXISTS app.audit_log (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id  UUID,
  action         TEXT         NOT NULL,
  target         TEXT         NOT NULL,
  before_value   TEXT,
  after_value    TEXT,
  ip             TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_action_length CHECK (char_length(action) <= 64),
  CONSTRAINT audit_log_target_format CHECK (target ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT audit_log_before_length CHECK (char_length(before_value) <= 32),
  CONSTRAINT audit_log_after_length CHECK (char_length(after_value) <= 32)
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON app.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON app.audit_log (target);

CREATE OR REPLACE FUNCTION app.audit_log_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'app.audit_log is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON app.audit_log;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_reject_change();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON app.audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON app.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_log_reject_change();
