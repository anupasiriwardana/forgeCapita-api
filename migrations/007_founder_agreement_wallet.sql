-- Founder revenue-share agreement acceptances (signed with the founder's wallet) and the
-- declared "shadow wallet" that staff must approve. One acceptance per user and agreement
-- version; one open (pending/approved) shadow wallet per user; an approved address is unique.

CREATE TABLE IF NOT EXISTS app.agreement_acceptances (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID         NOT NULL REFERENCES app.users (id),
  wallet_address     TEXT         NOT NULL,
  agreement_version  TEXT         NOT NULL,
  text_hash          CHAR(64)     NOT NULL,
  typed_name         TEXT         NOT NULL,
  message            TEXT         NOT NULL,
  signature          TEXT         NOT NULL,
  issued_at          TIMESTAMPTZ  NOT NULL,
  accepted_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ip                 TEXT,
  CONSTRAINT agreement_acceptances_user_version_key UNIQUE (user_id, agreement_version),
  CONSTRAINT agreement_acceptances_wallet_format CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT agreement_acceptances_version_length CHECK (char_length(agreement_version) BETWEEN 1 AND 32),
  CONSTRAINT agreement_acceptances_hash_format CHECK (text_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agreement_acceptances_name_length CHECK (char_length(typed_name) BETWEEN 2 AND 120)
);

CREATE TABLE IF NOT EXISTS app.founder_wallets (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES app.users (id),
  address       TEXT         NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'pending',
  review_note   TEXT,
  reviewed_by   UUID,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT founder_wallets_address_format CHECK (address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT founder_wallets_status_allowed CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT founder_wallets_review_note_length CHECK (char_length(review_note) <= 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS founder_wallets_open_user_idx
  ON app.founder_wallets (user_id) WHERE status IN ('pending', 'approved');
CREATE UNIQUE INDEX IF NOT EXISTS founder_wallets_approved_address_idx
  ON app.founder_wallets (address) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS founder_wallets_status_created_idx
  ON app.founder_wallets (status, created_at);
