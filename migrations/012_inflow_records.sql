-- Revenue audit, step A: every transfer INTO an approved founder shadow wallet as reported by the
-- chain explorer. Rows are append-only facts keyed by (chain, tx, kind, entry_ref) so re-polling the
-- same range never duplicates them. Nothing here is compared with on-chain revenue yet.

CREATE TABLE IF NOT EXISTS app.inflow_records (
  id            BIGSERIAL    PRIMARY KEY,
  chain_id      INTEGER      NOT NULL,
  wallet_address TEXT        NOT NULL,
  tx_hash       TEXT         NOT NULL,
  kind          TEXT         NOT NULL,
  entry_ref     TEXT         NOT NULL,
  token_address TEXT,
  token_symbol  TEXT,
  amount        NUMERIC(78,0) NOT NULL,
  from_address  TEXT         NOT NULL,
  block_number  BIGINT       NOT NULL,
  block_time    BIGINT       NOT NULL,
  first_seen_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT inflow_records_chain_allowed CHECK (chain_id IN (421614, 97)),
  CONSTRAINT inflow_records_wallet_format CHECK (wallet_address ~ '^0x[a-f0-9]{40}$'),
  CONSTRAINT inflow_records_from_format CHECK (from_address ~ '^0x[a-f0-9]{40}$'),
  CONSTRAINT inflow_records_tx_format CHECK (tx_hash ~ '^0x[a-f0-9]{64}$'),
  CONSTRAINT inflow_records_kind_allowed CHECK (kind IN ('native', 'internal', 'erc20')),
  CONSTRAINT inflow_records_amount_positive CHECK (amount > 0),
  CONSTRAINT inflow_records_token_format CHECK (token_address IS NULL OR token_address ~ '^0x[a-f0-9]{40}$'),
  CONSTRAINT inflow_records_token_by_kind CHECK (
    (kind = 'erc20' AND token_address IS NOT NULL) OR (kind <> 'erc20' AND token_address IS NULL)
  ),
  CONSTRAINT inflow_records_symbol_length CHECK (token_symbol IS NULL OR char_length(token_symbol) <= 32)
);

COMMENT ON TABLE app.inflow_records IS 'Explorer-reported transfers into approved founder shadow wallets (revenue audit, step A).';
COMMENT ON COLUMN app.inflow_records.kind IS 'native = normal tx value, internal = contract-sent native value, erc20 = token transfer.';
COMMENT ON COLUMN app.inflow_records.entry_ref IS 'Disambiguates several transfers in one tx: traceId, logIndex or a derived key; empty for native.';
COMMENT ON COLUMN app.inflow_records.amount IS 'Exact integer in the smallest unit (wei or token base units).';
COMMENT ON COLUMN app.inflow_records.token_symbol IS 'Untrusted text from the explorer, truncated to 32 characters; display only.';
COMMENT ON COLUMN app.inflow_records.block_time IS 'Unix seconds as reported by the explorer.';

CREATE UNIQUE INDEX IF NOT EXISTS inflow_records_unique_entry_uidx
  ON app.inflow_records (chain_id, tx_hash, kind, entry_ref);
CREATE INDEX IF NOT EXISTS inflow_records_wallet_time_idx
  ON app.inflow_records (chain_id, wallet_address, block_time);

CREATE TABLE IF NOT EXISTS app.inflow_cursors (
  chain_id       INTEGER      NOT NULL,
  wallet_address TEXT         NOT NULL,
  kind           TEXT         NOT NULL,
  last_block     BIGINT       NOT NULL DEFAULT 0,
  last_polled_at TIMESTAMPTZ,
  last_error     TEXT,
  PRIMARY KEY (chain_id, wallet_address, kind),
  CONSTRAINT inflow_cursors_chain_allowed CHECK (chain_id IN (421614, 97)),
  CONSTRAINT inflow_cursors_wallet_format CHECK (wallet_address ~ '^0x[a-f0-9]{40}$'),
  CONSTRAINT inflow_cursors_kind_allowed CHECK (kind IN ('native', 'internal', 'erc20')),
  CONSTRAINT inflow_cursors_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 200)
);

COMMENT ON TABLE app.inflow_cursors IS 'Per wallet and kind polling position for the explorer inflow job.';
COMMENT ON COLUMN app.inflow_cursors.last_error IS 'Short sanitised message (no URLs, no keys), at most 200 characters.';
