-- Moves public.startup_profiles into the app schema (no data loss) or creates the
-- final-shape table when none exists, then normalises columns and constraints.

DO $mig$
BEGIN
  IF to_regclass('app.startup_profiles') IS NULL THEN
    IF to_regclass('public.startup_profiles') IS NOT NULL THEN
      ALTER TABLE public.startup_profiles SET SCHEMA app;
    ELSE
      CREATE TABLE app.startup_profiles (
        project_id      VARCHAR      PRIMARY KEY,
        name            VARCHAR      NOT NULL,
        description     TEXT         NOT NULL,
        logo_url        VARCHAR,
        pitch_deck_url  VARCHAR,
        founder_bio     TEXT,
        website_url     VARCHAR,
        shadow_wallet   VARCHAR,
        kyc_verified    BOOLEAN      NOT NULL DEFAULT false,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    END IF;
  END IF;
END
$mig$;

DO $mig$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'startup_profiles'
      AND column_name = 'created_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE app.startup_profiles
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
  END IF;
END
$mig$;

ALTER TABLE app.startup_profiles
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE app.startup_profiles SET kyc_verified = false WHERE kyc_verified IS NULL;

ALTER TABLE app.startup_profiles
  ALTER COLUMN kyc_verified SET DEFAULT false,
  ALTER COLUMN kyc_verified SET NOT NULL;

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_project_id_format;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_project_id_format
  CHECK (project_id ~ '^[A-Za-z0-9:_-]{1,128}$');

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_name_length;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_name_length
  CHECK (char_length(name) BETWEEN 1 AND 120);

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_description_length;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_description_length
  CHECK (char_length(description) BETWEEN 1 AND 5000);

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_logo_url_length;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_logo_url_length
  CHECK (char_length(logo_url) <= 2048);

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_pitch_deck_url_length;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_pitch_deck_url_length
  CHECK (char_length(pitch_deck_url) <= 2048);

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_website_url_length;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_website_url_length
  CHECK (char_length(website_url) <= 2048);

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_founder_bio_length;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_founder_bio_length
  CHECK (char_length(founder_bio) <= 5000);

ALTER TABLE app.startup_profiles DROP CONSTRAINT IF EXISTS startup_profiles_shadow_wallet_format;
ALTER TABLE app.startup_profiles ADD CONSTRAINT startup_profiles_shadow_wallet_format
  CHECK (shadow_wallet IS NULL OR shadow_wallet ~ '^0x[a-fA-F0-9]{40}$');

CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $mig$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$mig$;

DROP TRIGGER IF EXISTS startup_profiles_set_updated_at ON app.startup_profiles;
CREATE TRIGGER startup_profiles_set_updated_at
  BEFORE UPDATE ON app.startup_profiles
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
