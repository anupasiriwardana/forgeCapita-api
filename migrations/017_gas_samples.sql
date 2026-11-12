-- Periodic gas price samples per chain, used to average the live minimum funding goal.
-- Rows older than 48 hours are pruned by the gas job.

CREATE TABLE IF NOT EXISTS app.gas_samples (
  id BIGSERIAL,
  chain_id INTEGER NOT NULL,
  gas_price_wei NUMERIC(78, 0) NOT NULL,
  sampled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gas_samples_pkey PRIMARY KEY (id),
  CONSTRAINT gas_samples_price_positive CHECK (gas_price_wei > 0)
);

CREATE INDEX IF NOT EXISTS gas_samples_chain_sampled_idx ON app.gas_samples (chain_id, sampled_at DESC);
