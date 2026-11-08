-- Automatic milestone execution: the API itself queues `execute` requests at the end of a voting
-- period. Those system requests have no user, so user_id becomes nullable, but only for that kind;
-- every user-initiated kind must still carry a user. `account` holds the relayer address for them.

ALTER TABLE app.relay_requests DROP CONSTRAINT IF EXISTS relay_requests_kind_allowed;
ALTER TABLE app.relay_requests
  ADD CONSTRAINT relay_requests_kind_allowed CHECK (kind IN ('claim', 'stake', 'vote', 'execute'));

ALTER TABLE app.relay_requests ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE app.relay_requests DROP CONSTRAINT IF EXISTS relay_requests_user_required;
ALTER TABLE app.relay_requests
  ADD CONSTRAINT relay_requests_user_required CHECK (user_id IS NOT NULL OR kind = 'execute');

COMMENT ON TABLE app.relay_requests IS 'Gasless relayer queue (claim, stake, vote) plus system execute requests; sent by the API relayer worker.';
