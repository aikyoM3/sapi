INSERT INTO supplier (user_id, supplier_name, phone_number, address)
SELECT u.user_id, 'Không xác định', NULL, NULL
FROM users u
WHERE NOT EXISTS (
  SELECT 1
  FROM supplier s
  WHERE s.user_id = u.user_id
    AND LOWER(s.supplier_name) = LOWER('Không xác định')
);
