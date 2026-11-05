-- Keys startup profiles to the indexer's project identity: project_id keeps holding the
-- composite id `<chainId>:<escrow lowercase>`, with chain_id and escrow_address stored
-- alongside it for the join with the Ponder project table. Adds an optional category.
-- Allowed chain ids are enforced by the API, not here.

ALTER TABLE app.startup_profiles
  ADD COLUMN IF NOT EXISTS chain_id INTEGER,
  ADD COLUMN IF NOT EXISTS escrow_address VARCHAR(42),
  ADD COLUMN IF NOT EXISTS category VARCHAR(32);

UPDATE app.startup_profiles
SET chain_id = split_part(project_id, ':', 1)::integer,
    escrow_address = lower(split_part(project_id, ':', 2))
WHERE (chain_id IS NULL OR escrow_address IS NULL)
  AND project_id ~ '^[0-9]{1,9}:0x[a-fA-F0-9]{40}$';

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_project_key;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_project_key
  CHECK (
    chain_id IS NOT NULL
    AND chain_id > 0
    AND escrow_address ~ '^0x[a-f0-9]{40}$'
    AND project_id = chain_id::text || ':' || escrow_address
  );

ALTER TABLE app.startup_profiles
  ALTER COLUMN chain_id SET NOT NULL,
  ALTER COLUMN escrow_address SET NOT NULL;

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_category_format;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_category_format
  CHECK (category IS NULL OR category ~ '^[a-z0-9][a-z0-9-]{0,31}$');

CREATE UNIQUE INDEX IF NOT EXISTS startup_profiles_chain_escrow_uidx
  ON app.startup_profiles (chain_id, escrow_address);
CREATE INDEX IF NOT EXISTS startup_profiles_created_at_idx
  ON app.startup_profiles (created_at DESC);
CREATE INDEX IF NOT EXISTS startup_profiles_category_idx
  ON app.startup_profiles (category);
