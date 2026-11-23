BEGIN;
CREATE TABLE IF NOT EXISTS web_planner_tasks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
  due_on DATE NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS web_planner_tasks_by_user ON web_planner_tasks(user_id, due_on, id);

-- Deleting a task does not reset the rolling creation quota.
CREATE TABLE IF NOT EXISTS web_planner_creations (
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX IF NOT EXISTS web_planner_creations_by_user ON web_planner_creations(user_id, created_at);

CREATE TABLE IF NOT EXISTS web_plus_orders (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  email TEXT,
  terms_version TEXT NOT NULL,
  vat_code INTEGER NOT NULL,
  payment_subject TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  days INTEGER NOT NULL CHECK (days > 0),
  is_test BOOLEAN NOT NULL,
  payment_id UUID UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'succeeded', 'canceled')),
  refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS web_plus_one_pending ON web_plus_orders(user_id, is_test) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS web_plus_orders_by_user ON web_plus_orders(user_id, is_test, paid_at, id);

CREATE TABLE IF NOT EXISTS web_plus_refunds (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES web_plus_orders(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0)
);
CREATE INDEX IF NOT EXISTS web_plus_refunds_by_order ON web_plus_refunds(order_id);

CREATE TABLE IF NOT EXISTS web_plus_access (
  user_id UUID NOT NULL,
  is_test BOOLEAN NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(user_id, is_test)
);

CREATE TABLE IF NOT EXISTS web_telegram_codes (
  chat_id BIGINT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS web_telegram_links (
  user_id UUID PRIMARY KEY,
  chat_id BIGINT NOT NULL UNIQUE
);
ALTER TABLE web_planner_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_planner_creations ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_plus_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_plus_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_plus_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_telegram_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_telegram_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON web_planner_tasks, web_planner_creations, web_plus_orders, web_plus_access,
  web_plus_refunds, web_telegram_codes, web_telegram_links FROM anon, authenticated, PUBLIC;
COMMIT;
