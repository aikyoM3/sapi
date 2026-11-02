CREATE TABLE IF NOT EXISTS gemini_connections (
  user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  api_key_encrypted TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'CONNECTED',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gemini_connection_status_check CHECK (status IN ('CONNECTED', 'ERROR'))
);
