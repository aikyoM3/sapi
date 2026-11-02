ALTER TABLE purchaseinvoice
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'PENDING_SYNC';

UPDATE purchaseinvoice
SET status = CASE
  WHEN kiotviet_purchase_order_id IS NOT NULL THEN 'SYNCED'
  ELSE 'PENDING_SYNC'
END;

ALTER TABLE purchaseinvoice
  ADD CONSTRAINT purchaseinvoice_status_check
  CHECK (status IN ('INCOMPLETE', 'PENDING_SYNC', 'SYNCED'));
