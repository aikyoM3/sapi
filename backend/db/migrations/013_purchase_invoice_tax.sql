-- Tax is entered in SAPI because the current KiotViet purchase-order input
-- used by this project has no separate tax field. It is allocated into item
-- prices only when sending to KiotViet.
ALTER TABLE purchaseinvoice
  ADD COLUMN IF NOT EXISTS tax_input_mode VARCHAR(10) NOT NULL DEFAULT 'PERCENT',
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(12, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(18, 2);

ALTER TABLE purchaseinvoice
  DROP CONSTRAINT IF EXISTS purchaseinvoice_tax_input_mode_check,
  DROP CONSTRAINT IF EXISTS purchaseinvoice_tax_nonnegative;

ALTER TABLE purchaseinvoice
  ADD CONSTRAINT purchaseinvoice_tax_input_mode_check CHECK (tax_input_mode IN ('PERCENT', 'VND')),
  ADD CONSTRAINT purchaseinvoice_tax_nonnegative CHECK (
    tax_rate >= 0 AND tax_amount >= 0
    AND (paid_amount IS NULL OR (paid_amount >= 0 AND paid_amount <= total_amount))
  );
