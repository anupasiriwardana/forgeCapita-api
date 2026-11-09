-- Revenue audit, step B: reconciliation of explorer-observed inflow against on-chain routed revenue.
-- One row per compliance case. A project that is checked and clean holds an OK row (updated on each
-- check, this is the "last check" shown by the transparency endpoint); a flagged project moves
-- OK -> WARNED -> ESCALATED and is closed as RESOLVED. At most one OPEN row (OK, WARNED, ESCALATED)
-- exists per project; RESOLVED and SHUTDOWN rows are history. Amounts are exact wei integers.

CREATE TABLE IF NOT EXISTS app.compliance_cases (
  id                 BIGSERIAL     PRIMARY KEY,
  project_id         TEXT          NOT NULL,
  chain_id           INTEGER       NOT NULL,
  state              TEXT          NOT NULL DEFAULT 'OK',
  opened_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  state_changed_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  escalated_at       TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  resolution_note    TEXT,
  last_checked_at    TIMESTAMPTZ,
  last_inflow_wei    NUMERIC(78,0),
  last_routed_wei    NUMERIC(78,0),
  last_shortfall_bps INTEGER,
  window_start       TIMESTAMPTZ,
  window_end         TIMESTAMPTZ,
  CONSTRAINT compliance_cases_project_format CHECK (project_id ~ '^[0-9]+:0x[a-f0-9]{40}$'),
  CONSTRAINT compliance_cases_chain_allowed CHECK (chain_id IN (421614, 97)),
  CONSTRAINT compliance_cases_state_allowed CHECK (state IN ('OK', 'WARNED', 'ESCALATED', 'RESOLVED', 'SHUTDOWN')),
  CONSTRAINT compliance_cases_note_length CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  CONSTRAINT compliance_cases_inflow_nonneg CHECK (last_inflow_wei IS NULL OR last_inflow_wei >= 0),
  CONSTRAINT compliance_cases_routed_nonneg CHECK (last_routed_wei IS NULL OR last_routed_wei >= 0),
  CONSTRAINT compliance_cases_shortfall_range CHECK (last_shortfall_bps IS NULL OR last_shortfall_bps BETWEEN 0 AND 10000)
);

COMMENT ON TABLE app.compliance_cases IS 'Revenue reconciliation cases; an OK row doubles as the last clean check of a project.';
COMMENT ON COLUMN app.compliance_cases.resolution_note IS 'Staff-only text; never exposed by the public transparency endpoint.';
COMMENT ON COLUMN app.compliance_cases.last_inflow_wei IS 'Native inflow into the bound wallet over the window, as seen by the explorer.';
COMMENT ON COLUMN app.compliance_cases.last_routed_wei IS 'Sum of on-chain revenue_record.gross for the project over the same window.';

-- At most one open case per project.
CREATE UNIQUE INDEX IF NOT EXISTS compliance_cases_open_project_uidx
  ON app.compliance_cases (project_id)
  WHERE state IN ('OK', 'WARNED', 'ESCALATED');
CREATE INDEX IF NOT EXISTS compliance_cases_project_idx ON app.compliance_cases (project_id, id DESC);
CREATE INDEX IF NOT EXISTS compliance_cases_state_idx ON app.compliance_cases (state, chain_id);
