-- Launch draft repository choice (WS-07.17): the founder picks which of their unlinked repositories
-- a launch draft will link to on apply. Nullable: legacy and staff drafts carry no repository.

ALTER TABLE app.launch_drafts
  ADD COLUMN IF NOT EXISTS repo_id UUID REFERENCES app.project_repos (id);

-- One active (pending or attached) draft per repository; the reservation frees itself when the
-- draft is cancelled, expired, in conflict or applied.
CREATE UNIQUE INDEX IF NOT EXISTS launch_drafts_active_repo_uidx
  ON app.launch_drafts (repo_id)
  WHERE repo_id IS NOT NULL AND status IN ('pending', 'attached');

COMMENT ON COLUMN app.launch_drafts.repo_id IS
  'Repository chosen at draft creation; linked to the project when the draft is applied. NULL for staff and legacy drafts.';
COMMENT ON INDEX app.launch_drafts_active_repo_uidx IS
  'A repository can be reserved by at most one pending or attached launch draft.';
