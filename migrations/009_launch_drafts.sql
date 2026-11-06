-- Launch drafts: the founder's profile and shadow wallet reservation are saved BEFORE the
-- on-chain launch. After launch the client attaches the escrow address and a reconcile job
-- applies the draft to app.startup_profiles once the indexer has the project and the
-- developer matches. A wallet is reserved by at most one active (pending/attached) draft.

CREATE TABLE IF NOT EXISTS app.launch_drafts (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID         NOT NULL REFERENCES app.users (id),
  wallet_address    TEXT         NOT NULL,
  chain_id          INTEGER      NOT NULL,
  founder_wallet_id UUID         REFERENCES app.founder_wallets (id),
  escrow_address    TEXT,
  project_id        TEXT,
  payload           JSONB        NOT NULL,
  status            TEXT         NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  attached_at       TIMESTAMPTZ,
  applied_at        TIMESTAMPTZ,
  CONSTRAINT launch_drafts_wallet_format CHECK (wallet_address ~ '^0x[a-f0-9]{40}$'),
  CONSTRAINT launch_drafts_chain_allowed CHECK (chain_id IN (421614, 97)),
  CONSTRAINT launch_drafts_escrow_format CHECK (escrow_address IS NULL OR escrow_address ~ '^0x[a-f0-9]{40}$'),
  CONSTRAINT launch_drafts_project_key CHECK (
    (escrow_address IS NULL AND project_id IS NULL)
    OR (escrow_address IS NOT NULL AND project_id = chain_id::text || ':' || escrow_address)
  ),
  CONSTRAINT launch_drafts_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT launch_drafts_status_allowed CHECK (
    status IN ('pending', 'attached', 'applied', 'cancelled', 'expired', 'conflict')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS launch_drafts_active_wallet_uidx
  ON app.launch_drafts (founder_wallet_id)
  WHERE founder_wallet_id IS NOT NULL AND status IN ('pending', 'attached');
CREATE UNIQUE INDEX IF NOT EXISTS launch_drafts_project_uidx
  ON app.launch_drafts (project_id)
  WHERE project_id IS NOT NULL AND status IN ('attached', 'applied');
CREATE INDEX IF NOT EXISTS launch_drafts_status_created_idx
  ON app.launch_drafts (status, created_at);
CREATE INDEX IF NOT EXISTS launch_drafts_user_idx
  ON app.launch_drafts (user_id);
