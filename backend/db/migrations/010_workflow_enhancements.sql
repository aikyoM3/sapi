-- Account-level automatic KiotViet synchronization. Disabled by default.
ALTER TABLE kiotviet_connections
  ADD COLUMN IF NOT EXISTS sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS next_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_error TEXT;

ALTER TABLE kiotviet_connections
  DROP CONSTRAINT IF EXISTS kiotviet_connections_sync_interval_check;
ALTER TABLE kiotviet_connections
  ADD CONSTRAINT kiotviet_connections_sync_interval_check
  CHECK (sync_interval_minutes BETWEEN 15 AND 1440);

-- Existing installations already have this table. The definition below keeps
-- migrations safe for a clean database as well.
CREATE TABLE IF NOT EXISTS suppliermapping (
  supplier_mapping_id SERIAL PRIMARY KEY,
  local_supplier_id INTEGER NOT NULL REFERENCES supplier(supplier_id) ON DELETE CASCADE,
  provider_supplier_name VARCHAR(255) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS suppliermapping_local_provider_name_unique
  ON suppliermapping (local_supplier_id, LOWER(provider_supplier_name));
