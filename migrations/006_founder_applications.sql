-- Founder applications: an investor applies to become a founder; staff/admin review the
-- application and record the KYC outcome. One open (pending/approved) application per
-- wallet; a rejected founder may apply again.

CREATE TABLE IF NOT EXISTS app.founder_applications (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID         NOT NULL REFERENCES app.users (id),
  wallet_address   TEXT         NOT NULL,
  project_name     TEXT         NOT NULL,
  summary          TEXT         NOT NULL,
  website_url      TEXT         NOT NULL,
  pitch_deck_url   TEXT         NOT NULL,
  repo_url         TEXT,
  contact          TEXT,
  status           TEXT         NOT NULL DEFAULT 'pending',
  review_note      TEXT,
  reviewed_by      UUID,
  reviewed_at      TIMESTAMPTZ,
  kyc_verified_at  TIMESTAMPTZ,
  kyc_verified_by  UUID,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT founder_applications_wallet_format CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT founder_applications_status_allowed CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT founder_applications_project_name_length CHECK (char_length(project_name) BETWEEN 1 AND 80),
  CONSTRAINT founder_applications_summary_length CHECK (char_length(summary) BETWEEN 1 AND 1000),
  CONSTRAINT founder_applications_website_url_format CHECK (char_length(website_url) <= 300 AND website_url ~ '^https://[^[:space:]]+$'),
  CONSTRAINT founder_applications_pitch_deck_url_format CHECK (char_length(pitch_deck_url) <= 300 AND pitch_deck_url ~ '^https://[^[:space:]]+$'),
  CONSTRAINT founder_applications_repo_url_format CHECK (repo_url IS NULL OR (char_length(repo_url) <= 300 AND repo_url ~ '^https://[^[:space:]]+$')),
  CONSTRAINT founder_applications_contact_length CHECK (char_length(contact) <= 200),
  CONSTRAINT founder_applications_review_note_length CHECK (char_length(review_note) <= 500),
  CONSTRAINT founder_applications_kyc_only_if_approved CHECK (
    status = 'approved' OR (kyc_verified_at IS NULL AND kyc_verified_by IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS founder_applications_open_wallet_idx
  ON app.founder_applications (wallet_address) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS founder_applications_status_created_idx
  ON app.founder_applications (status, created_at);
CREATE INDEX IF NOT EXISTS founder_applications_user_id_idx
  ON app.founder_applications (user_id, created_at DESC);
