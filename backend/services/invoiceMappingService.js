// Application-side mapping only. Gemini never maps products or suppliers.
// Lookups use existing tables when available; nothing is inserted or updated.

function emptySupplier() {
  return { supplier_id: null, name: null, phone: null, address: null, tax_code: null };
}

function correspondingFromGemini(gemini) {
  return {
    supplier: emptySupplier(),
    invoice: {
      number: gemini.invoice.number,
      date: gemini.invoice.date,
    },
    items: gemini.items.map((item) => ({
      product_id: null,
      name: null,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      total_price: item.total_price,
    })),
    total_amount: gemini.total_amount,
  };
}

async function lookupMappedProduct(pool, userId, extractedName) {
  if (!extractedName) return null;
  const { rows } = await pool.query(
    `
    SELECT p.product_id, p.product_name
    FROM product p
    LEFT JOIN productmapping pm ON p.product_id = pm.local_product_id
    WHERE p.user_id = $1
      AND (LOWER(p.product_name) = LOWER($2)
        OR (pm.provider_product_name IS NOT NULL AND LOWER(pm.provider_product_name) = LOWER($2)))
    ORDER BY CASE WHEN LOWER(p.product_name) = LOWER($2) THEN 0 ELSE 1 END, p.product_id
    LIMIT 1
    `,
    [userId, extractedName],
  );
  return rows[0] || null;
}

async function lookupMappedSupplier(pool, userId, extractedName) {
  if (!extractedName) return null;
  const { rows } = await pool.query(
    `
    SELECT s.supplier_id, s.supplier_name, s.phone_number, s.address
    FROM supplier s
    LEFT JOIN suppliermapping sm ON sm.local_supplier_id = s.supplier_id
    WHERE s.user_id = $1
      AND (LOWER(s.supplier_name) = LOWER($2)
        OR LOWER(sm.provider_supplier_name) = LOWER($2))
    ORDER BY CASE WHEN LOWER(s.supplier_name) = LOWER($2) THEN 0 ELSE 1 END, s.supplier_id
    LIMIT 1
    `,
    [userId, extractedName],
  );
  return rows[0] || null;
}

async function mapExtractedInvoice(pool, gemini, userId) {
  const corresponding = correspondingFromGemini(gemini);
  if (!pool || !userId) return corresponding;

  try {
    const supplier = await lookupMappedSupplier(pool, userId, gemini.supplier.name);
    if (supplier) corresponding.supplier = {
      ...corresponding.supplier,
      supplier_id: supplier.supplier_id,
      name: supplier.supplier_name,
      phone: supplier.phone_number,
      address: supplier.address,
    };
    for (let index = 0; index < gemini.items.length; index += 1) {
      const product = await lookupMappedProduct(pool, userId, gemini.items[index].name);
      if (product) {
        corresponding.items[index].product_id = product.product_id;
        corresponding.items[index].name = product.product_name;
      }
    }
  } catch (error) {
    console.warn('Invoice mapping lookup skipped:', error.message);
  }

  return corresponding;
}

module.exports = { mapExtractedInvoice, correspondingFromGemini };
