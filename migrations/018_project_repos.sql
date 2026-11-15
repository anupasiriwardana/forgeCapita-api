-- Source repositories provisioned for founders (GitHub only). project_id is set when the repo is
-- linked to a launched project; until then a founder may hold at most one unlinked repo.

CREATE TABLE IF NOT EXISTS app.project_repos (
  id                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  user_id             UUID         NOT NULL,
  provider            TEXT         NOT NULL,
  repo_id             BIGINT       NOT NULL,
  repo_name           TEXT         NOT NULL,
  full_name           TEXT         NOT NULL,
  html_url            TEXT         NOT NULL,
  founder_login       TEXT         NOT NULL,
  collaborator_id     BIGINT,
  collaborator_status TEXT         NOT NULL,
  project_id          TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT project_repos_pkey PRIMARY KEY (id),
  CONSTRAINT project_repos_user_fkey FOREIGN KEY (user_id) REFERENCES app.users (id),
  CONSTRAINT project_repos_provider_check CHECK (provider = 'github'),
  CONSTRAINT project_repos_status_check CHECK (collaborator_status IN ('invited', 'active', 'failed')),
  CONSTRAINT project_repos_founder_login_check CHECK (founder_login ~ '^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$'),
  CONSTRAINT project_repos_html_url_check CHECK (html_url LIKE 'https://%'),
  CONSTRAINT project_repos_full_name_check CHECK (full_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'),
  CONSTRAINT project_repos_repo_unique UNIQUE (provider, repo_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS project_repos_unlinked_user_uidx
  ON app.project_repos (user_id) WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS project_repos_user_created_idx ON app.project_repos (user_id, created_at DESC);
