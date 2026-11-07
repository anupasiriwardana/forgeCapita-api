-- Gasless relayer queue: one row per sponsored action (claim, stake, vote). The API validates and
-- simulates a request at intake, a worker then sends it from the relayer wallet and tracks the
-- receipt. `args` holds the calldata the worker must send (it contains the user's signature), so it
-- is never returned by the API nor logged; `payload` is the non-secret summary.

CREATE TABLE IF NOT EXISTS app.relay_requests (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                TEXT         NOT NULL,
  chain_id            INTEGER      NOT NULL,
  project_id          TEXT         NOT NULL,
  user_id             UUID         NOT NULL REFERENCES app.users (id),
  account             TEXT         NOT NULL,
  payload             JSONB        NOT NULL,
  args                JSONB        NOT NULL,
  idem_key            TEXT         NOT NULL,
  status              TEXT         NOT NULL DEFAULT 'QUEUED',
  error_code          TEXT,
  error_message       TEXT,
  tx_hash             TEXT,
  gas_used            NUMERIC,
  effective_gas_price NUMERIC,
  expires_at          TIMESTAMPTZ  NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,
  CONSTRAINT relay_requests_kind_allowed CHECK (kind IN ('claim', 'stake', 'vote')),
  CONSTRAINT relay_requests_chain_allowed CHECK (chain_id IN (421614, 97)),
  CONSTRAINT relay_requests_account_format CHECK (account ~ '^0x[a-f0-9]{40}$'),
  CONSTRAINT relay_requests_status_allowed CHECK (
    status IN ('QUEUED', 'SENDING', 'SENT', 'CONFIRMED', 'FAILED', 'EXPIRED')
  )
);

COMMENT ON TABLE app.relay_requests IS 'Gasless relayer queue (claim, stake, vote); sent by the API relayer worker.';
COMMENT ON COLUMN app.relay_requests.payload IS 'Non-secret summary of the action kept for audit.';
COMMENT ON COLUMN app.relay_requests.args IS 'Target and calldata to send; contains the user signature. Never log or return.';
COMMENT ON COLUMN app.relay_requests.idem_key IS 'Idempotency key; a FAILED/EXPIRED row is renamed on retry so a new request can reuse it.';
COMMENT ON COLUMN app.relay_requests.error_message IS 'Sanitised message (no URLs, no internals).';

CREATE UNIQUE INDEX IF NOT EXISTS relay_requests_idem_key_uidx
  ON app.relay_requests (idem_key);
CREATE INDEX IF NOT EXISTS relay_requests_status_chain_created_idx
  ON app.relay_requests (status, chain_id, created_at);
CREATE INDEX IF NOT EXISTS relay_requests_user_created_idx
  ON app.relay_requests (user_id, created_at);
