CREATE TABLE IF NOT EXISTS users (
  user_id SERIAL PRIMARY KEY,
  email VARCHAR(320) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  store_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email));

ALTER TABLE supplier ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(user_id) ON DELETE RESTRICT;
ALTER TABLE product ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(user_id) ON DELETE RESTRICT;
ALTER TABLE purchaseinvoice ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(user_id) ON DELETE RESTRICT;
ALTER TABLE purchaseinvoice ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(255);
ALTER TABLE purchaseinvoice ADD COLUMN IF NOT EXISTS discount_amount NUMERIC NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS supplier_user_id_idx ON supplier (user_id);
CREATE INDEX IF NOT EXISTS product_user_id_idx ON product (user_id);
CREATE INDEX IF NOT EXISTS purchaseinvoice_user_id_idx ON purchaseinvoice (user_id);

DROP INDEX IF EXISTS product_kiotviet_id_unique;
DROP INDEX IF EXISTS supplier_kiotviet_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS product_user_kiotviet_unique
  ON product (user_id, kiotviet_id) WHERE user_id IS NOT NULL AND kiotviet_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_user_kiotviet_unique
  ON supplier (user_id, kiotviet_id) WHERE user_id IS NOT NULL AND kiotviet_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoicesession (
  invoice_session_id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  session_token VARCHAR(128) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL DEFAULT 'WAITING_IMAGES',
  ocr_result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT invoicesession_status_check CHECK (status IN (
    'WAITING_IMAGES', 'UPLOADING', 'READY_TO_PROCESS', 'PROCESSING',
    'READY_FOR_REVIEW', 'CONFIRMED', 'FAILED'
  ))
);

CREATE INDEX IF NOT EXISTS invoicesession_user_created_idx ON invoicesession (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoicesession_expiry_idx ON invoicesession (expires_at);

CREATE TABLE IF NOT EXISTS invoicesessionimage (
  invoice_session_image_id BIGSERIAL PRIMARY KEY,
  invoice_session_id BIGINT NOT NULL REFERENCES invoicesession(invoice_session_id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  original_name VARCHAR(255),
  mime_type VARCHAR(100) NOT NULL,
  file_size INTEGER NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_session_id, page_number)
);

CREATE INDEX IF NOT EXISTS invoicesessionimage_session_idx ON invoicesessionimage (invoice_session_id, page_number);

CREATE TABLE IF NOT EXISTS user_session (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS user_session_expire_idx ON user_session (expire);
