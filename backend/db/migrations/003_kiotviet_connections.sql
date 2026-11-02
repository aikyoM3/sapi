ALTER TABLE users ALTER COLUMN store_name DROP NOT NULL;

CREATE TABLE IF NOT EXISTS kiotviet_connections (
  connection_id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  retailer_code VARCHAR(255) NOT NULL,
  retailer_name VARCHAR(255),
  client_id VARCHAR(255) NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'CONNECTED',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kiotviet_connection_status_check CHECK (status IN ('CONNECTED', 'DISCONNECTED', 'ERROR'))
);

CREATE TABLE IF NOT EXISTS kiotvietbranch (
  branch_id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kiotviet_id BIGINT NOT NULL,
  branch_name VARCHAR(255) NOT NULL,
  address TEXT,
  contact_number VARCHAR(100),
  kiotviet_modified_at TIMESTAMPTZ,
  UNIQUE (user_id, kiotviet_id)
);

CREATE INDEX IF NOT EXISTS kiotvietbranch_user_id_idx ON kiotvietbranch (user_id);
