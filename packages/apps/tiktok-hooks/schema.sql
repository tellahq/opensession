CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  creator TEXT NOT NULL,
  title TEXT NOT NULL,
  hook TEXT NOT NULL,
  transcript TEXT NOT NULL,
  language TEXT,
  kind TEXT,
  kind_reason TEXT,
  source TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  classified_at TEXT
);

CREATE TABLE IF NOT EXISTS failures (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TEXT NOT NULL
);
