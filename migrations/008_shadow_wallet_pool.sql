-- Shadow wallet pool: a founder may hold several staff-approved wallets but only one open
-- (pending) request; each project binds exactly one approved wallet and a wallet can be bound
-- to at most one project. An approved address stays unique across founders (see 007).

DROP INDEX IF EXISTS app.founder_wallets_open_user_idx;
CREATE UNIQUE INDEX IF NOT EXISTS founder_wallets_pending_user_idx
  ON app.founder_wallets (user_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS founder_wallets_approved_address_idx
  ON app.founder_wallets (address) WHERE status = 'approved';

ALTER TABLE app.startup_profiles
  ADD COLUMN IF NOT EXISTS founder_wallet_id UUID REFERENCES app.founder_wallets (id);
CREATE UNIQUE INDEX IF NOT EXISTS startup_profiles_founder_wallet_uidx
  ON app.startup_profiles (founder_wallet_id) WHERE founder_wallet_id IS NOT NULL;
