-- Admin lock-out: a repo whose collaborator access was revoked gets status 'revoked'.

ALTER TABLE app.project_repos DROP CONSTRAINT IF EXISTS project_repos_status_check;
ALTER TABLE app.project_repos
  ADD CONSTRAINT project_repos_status_check CHECK (collaborator_status IN ('invited', 'active', 'failed', 'revoked'));

ALTER TABLE app.project_repos ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
