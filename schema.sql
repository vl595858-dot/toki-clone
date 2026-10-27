-- Схема базы «Мои делишки» (Supabase Postgres). Даты — timestamptz (UTC).

-- повторяющиеся дела: шаблоны; ближайшие экземпляры материализуются в events
CREATE TABLE IF NOT EXISTS recurring_events (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  emoji TEXT DEFAULT '📌',
  weekday INT,                              -- 0..6, может быть NULL (daily/monthly/yearly)
  time TEXT,                                -- 'HH:MM' местное время чата
  remind_offset_minutes INT NOT NULL DEFAULT 0,
  frequency TEXT NOT NULL DEFAULT 'weekly', -- daily | weekly | monthly | yearly
  month_day INT,
  month INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  emoji TEXT DEFAULT '📌',
  event_at TIMESTAMPTZ NOT NULL,
  remind_at TIMESTAMPTZ,
  reminded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recurring_id INT REFERENCES recurring_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_events_remind
  ON events (remind_at)
  WHERE reminded = FALSE;

CREATE INDEX IF NOT EXISTS idx_events_chat
  ON events (chat_id, event_at);

-- память диалога (живёт 1 час)
CREATE TABLE IF NOT EXISTS chat_context (
  chat_id BIGINT PRIMARY KEY,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- часовой пояс чата, формат '+05:00'
CREATE TABLE IF NOT EXISTS user_settings (
  chat_id BIGINT PRIMARY KEY,
  tz_offset TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- обработанные сообщения Telegram (защита от дублей; создаётся автоматически, старше суток чистится)
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
