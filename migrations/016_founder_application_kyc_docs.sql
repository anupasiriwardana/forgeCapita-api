-- KYC documents link on the founder application: an https link (for example a shared drive folder) to
-- the applicant's identity documents, plus an optional note. Staff-only: never in the owner DTO, never
-- fetched server-side, never logged. Nullable at DB level for legacy rows (no backfill); the API requires it.

ALTER TABLE app.founder_applications
  ADD COLUMN IF NOT EXISTS kyc_docs_url TEXT,
  ADD COLUMN IF NOT EXISTS kyc_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_kyc_docs_url_format') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_kyc_docs_url_format
      CHECK (kyc_docs_url IS NULL OR (char_length(kyc_docs_url) <= 500
        AND kyc_docs_url ~ '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_kyc_note_length') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_kyc_note_length
      CHECK (kyc_note IS NULL OR char_length(kyc_note) <= 500);
  END IF;
END $$;

COMMENT ON COLUMN app.founder_applications.kyc_docs_url IS 'Staff-only link to KYC documents; never fetched or logged';
COMMENT ON COLUMN app.founder_applications.kyc_note IS 'Staff-only note from the applicant about the KYC documents';
