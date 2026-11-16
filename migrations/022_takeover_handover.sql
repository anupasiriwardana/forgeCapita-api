-- Takeover repository handover (WS-11.4d-2): after the new developer accepted on chain, an admin adds
-- their GitHub user to the project repository. The handover state lives on the case; all columns are
-- nullable and unset on every existing case.

ALTER TABLE app.takeover_cases
  ADD COLUMN IF NOT EXISTS new_developer_github_login TEXT
    CONSTRAINT takeover_cases_new_dev_login_check CHECK (
      new_developer_github_login IS NULL
      OR new_developer_github_login ~ '^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$'
    ),
  ADD COLUMN IF NOT EXISTS handover_status TEXT
    CONSTRAINT takeover_cases_handover_status_check CHECK (handover_status IS NULL OR handover_status IN ('invited', 'active')),
  ADD COLUMN IF NOT EXISTS handover_collaborator_id BIGINT,
  ADD COLUMN IF NOT EXISTS handover_repo_id UUID
    CONSTRAINT takeover_cases_handover_repo_fkey REFERENCES app.project_repos (id),
  ADD COLUMN IF NOT EXISTS handed_over_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handed_over_by UUID
    CONSTRAINT takeover_cases_handed_over_by_fkey REFERENCES app.users (id);

ALTER TABLE app.takeover_cases DROP CONSTRAINT IF EXISTS takeover_cases_handover_complete_check;
ALTER TABLE app.takeover_cases ADD CONSTRAINT takeover_cases_handover_complete_check CHECK (
  handover_status IS NULL OR (
    new_developer_github_login IS NOT NULL AND handover_repo_id IS NOT NULL
    AND handed_over_at IS NOT NULL AND handed_over_by IS NOT NULL
  )
);

COMMENT ON COLUMN app.takeover_cases.new_developer_github_login IS 'GitHub login of the new developer, typed by the admin at handover. The repository is shared with WRITE (push) access.';
COMMENT ON COLUMN app.takeover_cases.handover_status IS 'invited (GitHub invitation sent, not yet accepted) or active (already a collaborator); NULL until handed over. Access level is WRITE (push).';
COMMENT ON COLUMN app.takeover_cases.handover_collaborator_id IS 'GitHub invitation id; NULL when the user was already a collaborator. Never exposed through the API.';
COMMENT ON COLUMN app.takeover_cases.handover_repo_id IS 'The app.project_repos row the new developer was added to.';
COMMENT ON COLUMN app.takeover_cases.handed_over_at IS 'When the handover was first recorded.';
COMMENT ON COLUMN app.takeover_cases.handed_over_by IS 'Admin who performed the handover.';
