ALTER TABLE purchaseinvoice
  ADD COLUMN IF NOT EXISTS kiotviet_purchase_order_id BIGINT,
  ADD COLUMN IF NOT EXISTS kiotviet_purchase_order_code VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS purchaseinvoice_user_kiotviet_order_unique
  ON purchaseinvoice (user_id, kiotviet_purchase_order_id)
  WHERE kiotviet_purchase_order_id IS NOT NULL;
