ALTER TABLE supplier
  ADD CONSTRAINT supplier_user_id_required CHECK (user_id IS NOT NULL) NOT VALID;
ALTER TABLE product
  ADD CONSTRAINT product_user_id_required CHECK (user_id IS NOT NULL) NOT VALID;
ALTER TABLE purchaseinvoice
  ADD CONSTRAINT purchaseinvoice_user_id_required CHECK (user_id IS NOT NULL) NOT VALID;
ALTER TABLE purchaseinvoice
  ADD CONSTRAINT purchaseinvoice_discount_nonnegative CHECK (discount_amount >= 0) NOT VALID;
