-- Takeover voting (WS-11.4b): candidate acceptance, signed advisory votes, tally and closing.
-- Legacy cases opened by 020 (before this migration) have ends_at NULL and stay unvotable; the
-- vote_open CHECK is NOT VALID so those rows are tolerated while every new open must set the window.

ALTER TABLE app.takeover_cases
  ADD COLUMN IF NOT EXISTS candidate_accepted_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS candidate_acceptance_message   TEXT,
  ADD COLUMN IF NOT EXISTS candidate_acceptance_signature TEXT,
  ADD COLUMN IF NOT EXISTS candidate_acceptance_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS developer_at_open           TEXT
    CONSTRAINT takeover_cases_developer_at_open_check CHECK (developer_at_open IS NULL OR developer_at_open ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN IF NOT EXISTS ends_at                     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at                   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS result                      TEXT
    CONSTRAINT takeover_cases_result_check CHECK (result IS NULL OR result IN ('passed', 'failed', 'no_quorum')),
  ADD COLUMN IF NOT EXISTS yes_weight                  NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS no_weight                   NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS voted_weight                NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS voter_count                 INTEGER,
  ADD COLUMN IF NOT EXISTS quorum_percent              INTEGER
    CONSTRAINT takeover_cases_quorum_percent_check CHECK (quorum_percent IS NULL OR quorum_percent BETWEEN 1 AND 100);

ALTER TABLE app.takeover_cases DROP CONSTRAINT IF EXISTS takeover_cases_closed_check;
ALTER TABLE app.takeover_cases ADD CONSTRAINT takeover_cases_closed_check CHECK (
  status <> 'closed' OR (
    closed_at IS NOT NULL AND result IS NOT NULL AND yes_weight IS NOT NULL AND no_weight IS NOT NULL
    AND voted_weight IS NOT NULL AND voter_count IS NOT NULL
  )
) NOT VALID;

ALTER TABLE app.takeover_cases DROP CONSTRAINT IF EXISTS takeover_cases_vote_open_check;
ALTER TABLE app.takeover_cases ADD CONSTRAINT takeover_cases_vote_open_check CHECK (
  status <> 'vote_open' OR (ends_at IS NOT NULL AND quorum_percent IS NOT NULL AND developer_at_open IS NOT NULL)
) NOT VALID;

CREATE OR REPLACE FUNCTION app.takeover_cases_freeze_vote() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.candidate_accepted_at IS NOT NULL AND (
        NEW.candidate_accepted_at IS DISTINCT FROM OLD.candidate_accepted_at
        OR NEW.candidate_acceptance_message IS DISTINCT FROM OLD.candidate_acceptance_message
        OR NEW.candidate_acceptance_signature IS DISTINCT FROM OLD.candidate_acceptance_signature
        OR NEW.candidate_acceptance_issued_at IS DISTINCT FROM OLD.candidate_acceptance_issued_at))
    OR (OLD.developer_at_open IS NOT NULL AND NEW.developer_at_open IS DISTINCT FROM OLD.developer_at_open)
    OR (OLD.ends_at IS NOT NULL AND NEW.ends_at IS DISTINCT FROM OLD.ends_at)
    OR (OLD.quorum_percent IS NOT NULL AND NEW.quorum_percent IS DISTINCT FROM OLD.quorum_percent)
    OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at)
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.yes_weight IS NOT NULL AND NEW.yes_weight IS DISTINCT FROM OLD.yes_weight)
    OR (OLD.no_weight IS NOT NULL AND NEW.no_weight IS DISTINCT FROM OLD.no_weight)
    OR (OLD.voted_weight IS NOT NULL AND NEW.voted_weight IS DISTINCT FROM OLD.voted_weight)
    OR (OLD.voter_count IS NOT NULL AND NEW.voter_count IS DISTINCT FROM OLD.voter_count)
  THEN
    RAISE EXCEPTION 'takeover acceptance, vote window and result columns are immutable once set';
  END IF;
  IF OLD.candidate_accepted_at IS NULL AND NEW.candidate_accepted_at IS NOT NULL
     AND (OLD.status <> 'prepared' OR NEW.status <> 'prepared') THEN
    RAISE EXCEPTION 'candidate acceptance is only allowed while the case is prepared';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS takeover_cases_freeze_vote ON app.takeover_cases;
CREATE TRIGGER takeover_cases_freeze_vote
  BEFORE UPDATE ON app.takeover_cases
  FOR EACH ROW EXECUTE FUNCTION app.takeover_cases_freeze_vote();

CREATE TABLE IF NOT EXISTS app.takeover_votes (
  case_id       UUID          NOT NULL,
  voter_address TEXT          NOT NULL,
  choice        TEXT          NOT NULL,
  weight        NUMERIC(78,0) NOT NULL,
  message       TEXT          NOT NULL,
  signature     TEXT          NOT NULL,
  issued_at     TIMESTAMPTZ   NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT takeover_votes_pkey PRIMARY KEY (case_id, voter_address),
  CONSTRAINT takeover_votes_case_fkey FOREIGN KEY (case_id) REFERENCES app.takeover_cases (id),
  CONSTRAINT takeover_votes_voter_check CHECK (voter_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT takeover_votes_choice_check CHECK (choice IN ('YES', 'NO')),
  CONSTRAINT takeover_votes_weight_check CHECK (weight > 0)
);

CREATE INDEX IF NOT EXISTS takeover_votes_case_idx ON app.takeover_votes (case_id);

CREATE OR REPLACE FUNCTION app.takeover_votes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  case_status TEXT;
  case_ends   TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app.takeover_votes rows cannot be deleted';
  END IF;
  SELECT status, ends_at INTO case_status, case_ends FROM app.takeover_cases WHERE id = NEW.case_id;
  IF case_status IS DISTINCT FROM 'vote_open' OR case_ends IS NULL OR now() >= case_ends THEN
    RAISE EXCEPTION 'takeover vote is not open for this case';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.case_id <> OLD.case_id OR NEW.voter_address <> OLD.voter_address
       OR NEW.weight <> OLD.weight OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'takeover vote case, voter, weight and creation time are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS takeover_votes_guard_write ON app.takeover_votes;
CREATE TRIGGER takeover_votes_guard_write
  BEFORE INSERT OR UPDATE ON app.takeover_votes
  FOR EACH ROW EXECUTE FUNCTION app.takeover_votes_guard();

DROP TRIGGER IF EXISTS takeover_votes_guard_delete ON app.takeover_votes;
CREATE TRIGGER takeover_votes_guard_delete
  BEFORE DELETE ON app.takeover_votes
  FOR EACH ROW EXECUTE FUNCTION app.takeover_votes_guard();

COMMENT ON TABLE app.takeover_votes IS 'Signed ADVISORY votes of a takeover case; one row per snapshot staker, changeable until ends_at, never deletable. Per-address rows are staff/admin only.';
COMMENT ON COLUMN app.takeover_votes.weight IS 'Snapshot staked_balance (wei) of the voter, copied at the first vote; immutable.';
COMMENT ON COLUMN app.takeover_votes.message IS 'Exact EIP-191 text the voter signed (never exposed through the API).';
COMMENT ON COLUMN app.takeover_votes.signature IS 'EIP-191 signature of message (never exposed through the API).';
COMMENT ON COLUMN app.takeover_votes.issued_at IS 'Client issuedAt of the stored vote; an update must carry a strictly newer value (replay protection).';
COMMENT ON COLUMN app.takeover_cases.candidate_accepted_at IS 'When the candidate signed the off-chain acceptance; required before the vote can be opened. Never public.';
COMMENT ON COLUMN app.takeover_cases.candidate_acceptance_message IS 'Signed acceptance text (never exposed through the API).';
COMMENT ON COLUMN app.takeover_cases.candidate_acceptance_signature IS 'Signature over the acceptance text (never exposed through the API).';
COMMENT ON COLUMN app.takeover_cases.candidate_acceptance_issued_at IS 'issuedAt carried by the acceptance message.';
COMMENT ON COLUMN app.takeover_cases.developer_at_open IS 'Indexed developer of the project when the vote was opened; excluded from voting. Frozen.';
COMMENT ON COLUMN app.takeover_cases.ends_at IS 'End of the voting window (DB clock at open + TAKEOVER_VOTE_DAYS). NULL on legacy 11.4a cases, which are not votable.';
COMMENT ON COLUMN app.takeover_cases.closed_at IS 'When the case was closed (lazily on read or by an admin) and its result persisted.';
COMMENT ON COLUMN app.takeover_cases.result IS 'passed, failed or no_quorum; advisory only.';
COMMENT ON COLUMN app.takeover_cases.yes_weight IS 'Persisted YES weight (wei) at close.';
COMMENT ON COLUMN app.takeover_cases.no_weight IS 'Persisted NO weight (wei) at close.';
COMMENT ON COLUMN app.takeover_cases.voted_weight IS 'Persisted yes + no weight (wei) at close.';
COMMENT ON COLUMN app.takeover_cases.voter_count IS 'Number of voters at close.';
COMMENT ON COLUMN app.takeover_cases.quorum_percent IS 'Quorum percent of snapshot_total_staked frozen at open.';
