-- Investor complaints about a project. Filed by any signed-in user, visible only to the reporter and
-- staff. staff_note is staff-only text and is never shown to the reporter. At most one active
-- (OPEN or INVESTIGATING) complaint exists per reporter, project and category; RESOLVED and
-- DISMISSED rows are terminal history.

CREATE TABLE IF NOT EXISTS app.complaints (
  id               BIGSERIAL     PRIMARY KEY,
  project_id       TEXT          NOT NULL,
  chain_id         INTEGER       NOT NULL,
  reporter_user_id UUID          NOT NULL REFERENCES app.users (id),
  category         TEXT          NOT NULL,
  body             TEXT          NOT NULL,
  evidence_url     TEXT,
  status           TEXT          NOT NULL DEFAULT 'OPEN',
  staff_note       TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  CONSTRAINT complaints_project_format CHECK (project_id ~ '^[0-9]+:0x[a-f0-9]{40}$'),
  CONSTRAINT complaints_chain_allowed CHECK (chain_id IN (421614, 97)),
  CONSTRAINT complaints_category_allowed CHECK (category IN ('MISREPRESENTATION', 'REVENUE_UNDERREPORTING', 'INACTIVITY', 'SECURITY', 'OTHER')),
  CONSTRAINT complaints_status_allowed CHECK (status IN ('OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED')),
  CONSTRAINT complaints_body_length CHECK (char_length(body) BETWEEN 20 AND 2000),
  CONSTRAINT complaints_evidence_url_format CHECK (evidence_url IS NULL OR (char_length(evidence_url) <= 500 AND evidence_url ~ '^https://')),
  CONSTRAINT complaints_staff_note_length CHECK (staff_note IS NULL OR char_length(staff_note) <= 1000)
);

COMMENT ON TABLE app.complaints IS 'Investor complaints; reporter and staff only, never public.';
COMMENT ON COLUMN app.complaints.staff_note IS 'Staff-only text; never returned to the reporter and never logged.';

CREATE UNIQUE INDEX IF NOT EXISTS complaints_active_uidx
  ON app.complaints (reporter_user_id, project_id, category)
  WHERE status IN ('OPEN', 'INVESTIGATING');
CREATE INDEX IF NOT EXISTS complaints_status_idx ON app.complaints (status, id DESC);
CREATE INDEX IF NOT EXISTS complaints_project_idx ON app.complaints (project_id);
CREATE INDEX IF NOT EXISTS complaints_reporter_idx ON app.complaints (reporter_user_id, created_at DESC);
