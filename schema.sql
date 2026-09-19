CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  emoji TEXT DEFAULT '📌',
  event_at TIMESTAMPTZ NOT NULL,
  remind_at TIMESTAMPTZ,
  reminded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_remind
  ON events (remind_at)
  WHERE reminded = FALSE;

CREATE INDEX IF NOT EXISTS idx_events_chat
  ON events (chat_id, event_at);
