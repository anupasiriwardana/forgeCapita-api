-- Wallet sign-in: users (role per wallet), single-use sign-in nonces and opaque
-- server-side sessions. Only the sha256 of the session token is stored.

CREATE TABLE IF NOT EXISTS app.users (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT         NOT NULL UNIQUE,
  role           TEXT         NOT NULL DEFAULT 'investor',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ,
  CONSTRAINT users_wallet_address_format CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT users_role_allowed CHECK (role IN ('investor', 'founder', 'staff', 'admin'))
);

CREATE TABLE IF NOT EXISTS app.auth_nonces (
  address     TEXT         PRIMARY KEY,
  nonce       TEXT         NOT NULL,
  message     TEXT         NOT NULL,
  expires_at  TIMESTAMPTZ  NOT NULL,
  CONSTRAINT auth_nonces_address_format CHECK (address ~ '^0x[0-9a-f]{40}$')
);

CREATE TABLE IF NOT EXISTS app.sessions (
  id_hash       TEXT         PRIMARY KEY,
  user_id       UUID         NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  CONSTRAINT sessions_user_agent_length CHECK (char_length(user_agent) <= 200)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON app.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON app.sessions (expires_at);
