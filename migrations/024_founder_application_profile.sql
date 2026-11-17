-- Founder application redesign: a resume link, a short "about", profile links (LinkedIn, GitHub,
-- portfolio, other) replace the old project fields (basic details live in the user profile).
-- Legacy rows keep working: the old columns stay, the NOT NULLs are dropped and every new CHECK
-- tolerates NULL. Required-ness of resume_url/about is enforced by the API, not the database.

ALTER TABLE app.founder_applications
  ADD COLUMN IF NOT EXISTS resume_url TEXT,
  ADD COLUMN IF NOT EXISTS about TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_url TEXT,
  ADD COLUMN IF NOT EXISTS github_url TEXT,
  ADD COLUMN IF NOT EXISTS portfolio_url TEXT,
  ADD COLUMN IF NOT EXISTS other_links TEXT[];

ALTER TABLE app.founder_applications
  ALTER COLUMN project_name DROP NOT NULL,
  ALTER COLUMN summary DROP NOT NULL,
  ALTER COLUMN website_url DROP NOT NULL,
  ALTER COLUMN pitch_deck_url DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_resume_url_format') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_resume_url_format
      CHECK (resume_url IS NULL OR (char_length(resume_url) <= 500
        AND resume_url ~ '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_about_length') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_about_length
      CHECK (about IS NULL OR char_length(btrim(about)) BETWEEN 50 AND 1500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_linkedin_url_format') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_linkedin_url_format
      CHECK (linkedin_url IS NULL OR (char_length(linkedin_url) <= 300
        AND linkedin_url ~* '^https://(www\.|[a-z]{2}\.)?linkedin\.com/in/[^[:space:]/?#]+/?([?#][^[:space:]]*)?$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_github_url_format') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_github_url_format
      CHECK (github_url IS NULL OR (char_length(github_url) <= 300
        AND github_url ~* '^https://(www\.)?github\.com/[A-Za-z0-9-]+/?([?#][^[:space:]]*)?$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_portfolio_url_format') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_portfolio_url_format
      CHECK (portfolio_url IS NULL OR (char_length(portfolio_url) <= 300
        AND portfolio_url ~ '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_other_links_count') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_other_links_count
      CHECK (other_links IS NULL OR cardinality(other_links) <= 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_new_format_consistent') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_new_format_consistent
      CHECK ((resume_url IS NULL) = (about IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'founder_applications_one_link_required') THEN
    ALTER TABLE app.founder_applications ADD CONSTRAINT founder_applications_one_link_required
      CHECK (resume_url IS NULL OR linkedin_url IS NOT NULL OR github_url IS NOT NULL OR portfolio_url IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN app.founder_applications.resume_url IS 'Staff-only link to the applicant resume; never fetched or logged';
