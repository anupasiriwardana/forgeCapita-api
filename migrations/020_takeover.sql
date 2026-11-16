-- Developer takeover cases (WS-11.4a): staff prepare a case for a candidate developer, an admin opens
-- the vote, which freezes a stake snapshot taken from the indexed ponder.position table.
-- Precision trade-off: the snapshot is INDEXED state, read live at open time, so the recorded head
-- block is a lower bound ("indexed at or after block N") and snapshot_lag_seconds says how stale the
-- indexer was. The off-chain vote is advisory; it cannot bind the contracts.

CREATE OR REPLACE FUNCTION app.takeover_links_valid(links TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(cardinality(links), 0) <= 10
     AND NOT EXISTS (
       SELECT 1 FROM unnest(links) AS l
       WHERE l IS NULL OR l NOT LIKE 'https://%' OR char_length(l) > 500
     );
$$;

CREATE TABLE IF NOT EXISTS app.takeover_cases (
  id                       UUID          NOT NULL DEFAULT gen_random_uuid(),
  chain_id                 INTEGER       NOT NULL,
  project_id               TEXT          NOT NULL,
  candidate_wallet         TEXT          NOT NULL,
  candidate_user_id        UUID          NOT NULL,
  reason                   TEXT          NOT NULL,
  evidence_links           TEXT[]        NOT NULL DEFAULT '{}',
  status                   TEXT          NOT NULL DEFAULT 'prepared',
  created_by               UUID          NOT NULL,
  opened_by                UUID,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  opened_at                TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  snapshot_block           BIGINT,
  snapshot_block_timestamp TIMESTAMPTZ,
  snapshot_taken_at        TIMESTAMPTZ,
  snapshot_lag_seconds     INTEGER,
  snapshot_total_staked    NUMERIC(78,0),
  snapshot_holder_count    INTEGER,
  CONSTRAINT takeover_cases_pkey PRIMARY KEY (id),
  CONSTRAINT takeover_cases_candidate_user_fkey FOREIGN KEY (candidate_user_id) REFERENCES app.users (id),
  CONSTRAINT takeover_cases_created_by_fkey FOREIGN KEY (created_by) REFERENCES app.users (id),
  CONSTRAINT takeover_cases_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES app.users (id),
  CONSTRAINT takeover_cases_project_id_check CHECK (project_id ~ '^[0-9]+:0x[0-9a-f]{40}$'),
  CONSTRAINT takeover_cases_candidate_wallet_check CHECK (candidate_wallet ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT takeover_cases_reason_check CHECK (char_length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT takeover_cases_evidence_check CHECK (app.takeover_links_valid(evidence_links)),
  CONSTRAINT takeover_cases_status_check CHECK (status IN ('prepared', 'vote_open', 'closed', 'cancelled')),
  CONSTRAINT takeover_cases_snapshot_check CHECK (
    status NOT IN ('vote_open', 'closed') OR (
      snapshot_block IS NOT NULL AND snapshot_block_timestamp IS NOT NULL AND snapshot_taken_at IS NOT NULL
      AND snapshot_lag_seconds IS NOT NULL AND snapshot_total_staked IS NOT NULL AND snapshot_holder_count IS NOT NULL
    )
  )
);

-- One active case per project.
CREATE UNIQUE INDEX IF NOT EXISTS takeover_cases_active_project_uidx
  ON app.takeover_cases (project_id) WHERE status IN ('prepared', 'vote_open');
CREATE INDEX IF NOT EXISTS takeover_cases_created_idx ON app.takeover_cases (created_at DESC);

CREATE TABLE IF NOT EXISTS app.takeover_snapshot_holders (
  case_id           UUID          NOT NULL,
  investor_address  TEXT          NOT NULL,
  staked_balance    NUMERIC(78,0) NOT NULL,
  unstaked_balance  NUMERIC(78,0),
  CONSTRAINT takeover_snapshot_holders_pkey PRIMARY KEY (case_id, investor_address),
  CONSTRAINT takeover_snapshot_holders_case_fkey FOREIGN KEY (case_id) REFERENCES app.takeover_cases (id),
  CONSTRAINT takeover_snapshot_holders_address_check CHECK (investor_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT takeover_snapshot_holders_staked_check CHECK (staked_balance > 0),
  CONSTRAINT takeover_snapshot_holders_unstaked_check CHECK (unstaked_balance IS NULL OR unstaked_balance >= 0)
);

CREATE OR REPLACE FUNCTION app.takeover_holders_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'app.takeover_snapshot_holders is immutable';
END;
$$;

DROP TRIGGER IF EXISTS takeover_holders_no_update_delete ON app.takeover_snapshot_holders;
CREATE TRIGGER takeover_holders_no_update_delete
  BEFORE UPDATE OR DELETE ON app.takeover_snapshot_holders
  FOR EACH ROW EXECUTE FUNCTION app.takeover_holders_reject_change();

CREATE OR REPLACE FUNCTION app.takeover_cases_freeze_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.snapshot_taken_at IS NOT NULL AND (
    NEW.snapshot_block IS DISTINCT FROM OLD.snapshot_block
    OR NEW.snapshot_block_timestamp IS DISTINCT FROM OLD.snapshot_block_timestamp
    OR NEW.snapshot_taken_at IS DISTINCT FROM OLD.snapshot_taken_at
    OR NEW.snapshot_lag_seconds IS DISTINCT FROM OLD.snapshot_lag_seconds
    OR NEW.snapshot_total_staked IS DISTINCT FROM OLD.snapshot_total_staked
    OR NEW.snapshot_holder_count IS DISTINCT FROM OLD.snapshot_holder_count
  ) THEN
    RAISE EXCEPTION 'takeover snapshot columns are immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS takeover_cases_freeze_snapshot ON app.takeover_cases;
CREATE TRIGGER takeover_cases_freeze_snapshot
  BEFORE UPDATE ON app.takeover_cases
  FOR EACH ROW EXECUTE FUNCTION app.takeover_cases_freeze_snapshot();

COMMENT ON TABLE app.takeover_cases IS 'Developer takeover cases. Prepared by staff, opened/cancelled by admin only. The vote is advisory (off-chain).';
COMMENT ON COLUMN app.takeover_cases.project_id IS 'Ponder project id, lowercase chainId:escrowAddress.';
COMMENT ON COLUMN app.takeover_cases.reason IS 'Staff-written justification (never copied into audit rows or logs).';
COMMENT ON COLUMN app.takeover_cases.evidence_links IS 'Up to 10 https links, each at most 500 characters.';
COMMENT ON COLUMN app.takeover_cases.snapshot_block IS 'Indexed head block reported by the indexer at open time; the position read is live, so this is a lower bound (indexed at or after this block).';
COMMENT ON COLUMN app.takeover_cases.snapshot_block_timestamp IS 'Timestamp of snapshot_block as reported by the indexer.';
COMMENT ON COLUMN app.takeover_cases.snapshot_taken_at IS 'Wall-clock time the snapshot was taken by the API.';
COMMENT ON COLUMN app.takeover_cases.snapshot_lag_seconds IS 'Seconds between snapshot_taken_at and snapshot_block_timestamp.';
COMMENT ON COLUMN app.takeover_cases.snapshot_total_staked IS 'Sum of the snapshotted staked balances (token wei).';
COMMENT ON COLUMN app.takeover_cases.snapshot_holder_count IS 'Number of holders with a staked balance above zero.';
COMMENT ON TABLE app.takeover_snapshot_holders IS 'Frozen per-holder stake snapshot of a takeover case. Immutable (UPDATE/DELETE rejected). Only holders with staked_balance > 0.';
COMMENT ON COLUMN app.takeover_snapshot_holders.staked_balance IS 'Staked token balance (wei) from ponder.position.staked_balance at open time.';
COMMENT ON COLUMN app.takeover_snapshot_holders.unstaked_balance IS 'APPROXIMATE unstaked balance (wei) from ponder.position.tokens_held; may be null or stale.';
