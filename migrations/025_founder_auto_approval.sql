-- Founder auto-approval (testing aid, FOUNDER_APPROVAL=AUTO): marks founder applications and shadow
-- wallets that were approved by the server without staff review. Existing rows stay false.

ALTER TABLE app.founder_applications
  ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE app.founder_wallets
  ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN NOT NULL DEFAULT false;
