CREATE TABLE IF NOT EXISTS plus_test_orders (
  id UUID PRIMARY KEY,
  browser_token_hash TEXT NOT NULL UNIQUE,
  telegram_user_id BIGINT,
  payment_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'canceled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_until TIMESTAMPTZ,
  CHECK ((status = 'succeeded') = (access_until IS NOT NULL)),
  CHECK (payment_id IS NULL OR telegram_user_id IS NOT NULL)
);

ALTER TABLE plus_test_orders ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS plus_test_orders_user_access_idx
  ON plus_test_orders (telegram_user_id, access_until DESC)
  WHERE access_until IS NOT NULL;
