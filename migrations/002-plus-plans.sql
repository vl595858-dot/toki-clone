BEGIN;

CREATE TABLE IF NOT EXISTS plus_access (
  chat_id BIGINT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS plus_promo_codes (
  code_hash TEXT PRIMARY KEY,
  issued_by BIGINT NOT NULL,
  duration_days INTEGER NOT NULL CHECK (duration_days IN (30, 365)),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 10000),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses BETWEEN 0 AND max_uses),
  CHECK (duration_days = 30 OR max_uses = 1)
);

CREATE TABLE IF NOT EXISTS plus_promo_redemptions (
  code_hash TEXT NOT NULL REFERENCES plus_promo_codes (code_hash),
  chat_id BIGINT NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  granted_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (code_hash, chat_id)
);

CREATE TABLE IF NOT EXISTS plus_usage (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('event', 'voice', 'image')),
  units INTEGER NOT NULL CHECK (units > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX IF NOT EXISTS plus_usage_lookup_idx ON plus_usage (chat_id, action, occurred_at);

ALTER TABLE plus_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE plus_promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE plus_promo_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plus_usage ENABLE ROW LEVEL SECURITY;

COMMIT;
