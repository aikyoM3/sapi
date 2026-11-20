-- Supplier-specific unit conversion confirmed by the user.
-- Local quantity = extracted quantity * conversion_rate_to_local.
ALTER TABLE productmapping
  ADD COLUMN IF NOT EXISTS conversion_rate_to_local NUMERIC(18, 6);

ALTER TABLE productmapping
  DROP CONSTRAINT IF EXISTS productmapping_conversion_rate_check;
ALTER TABLE productmapping
  ADD CONSTRAINT productmapping_conversion_rate_check
  CHECK (conversion_rate_to_local IS NULL OR conversion_rate_to_local > 0);
