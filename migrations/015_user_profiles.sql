-- Personal profile of a signed-in user (name, contact, postal address, date of birth). PII: owner and
-- staff only, never public, never logged and never copied into audit rows. The email is contact
-- information only and is NOT verified. The 18+ rule is enforced in the API (a CHECK cannot use now()).

CREATE TABLE IF NOT EXISTS app.user_profiles (
  user_id       UUID         PRIMARY KEY REFERENCES app.users (id),
  first_name    TEXT         NOT NULL,
  last_name     TEXT         NOT NULL,
  email         TEXT         NOT NULL,
  phone         TEXT         NOT NULL,
  address_line1 TEXT         NOT NULL,
  address_line2 TEXT,
  city          TEXT         NOT NULL,
  region        TEXT,
  postal_code   TEXT         NOT NULL,
  country       TEXT         NOT NULL,
  date_of_birth DATE         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT user_profiles_first_name_length CHECK (char_length(first_name) BETWEEN 1 AND 80),
  CONSTRAINT user_profiles_last_name_length CHECK (char_length(last_name) BETWEEN 1 AND 80),
  CONSTRAINT user_profiles_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT user_profiles_phone_length CHECK (char_length(phone) BETWEEN 7 AND 20),
  CONSTRAINT user_profiles_address_line1_length CHECK (char_length(address_line1) BETWEEN 1 AND 120),
  CONSTRAINT user_profiles_address_line2_length CHECK (address_line2 IS NULL OR char_length(address_line2) BETWEEN 1 AND 120),
  CONSTRAINT user_profiles_city_length CHECK (char_length(city) BETWEEN 1 AND 80),
  CONSTRAINT user_profiles_region_length CHECK (region IS NULL OR char_length(region) BETWEEN 1 AND 80),
  CONSTRAINT user_profiles_postal_code_length CHECK (char_length(postal_code) BETWEEN 1 AND 20),
  CONSTRAINT user_profiles_country_format CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT user_profiles_dob_plausible CHECK (date_of_birth > DATE '1900-01-01')
);

COMMENT ON TABLE app.user_profiles IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.first_name IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.last_name IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.email IS 'PII, owner and staff only; contact only, not verified';
COMMENT ON COLUMN app.user_profiles.phone IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.address_line1 IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.address_line2 IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.city IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.region IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.postal_code IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.country IS 'PII, owner and staff only';
COMMENT ON COLUMN app.user_profiles.date_of_birth IS 'PII, owner and staff only';
