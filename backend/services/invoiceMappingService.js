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
      unit_price: normalizedUnitPrice(item),
      total_price: item.total_price,
    })),
    total_amount: gemini.total_amount,
  };
}

function normalizedUnitPrice(item) {
  const quantity = Number(item.quantity);
  const total = item.total_price === null || item.total_price === undefined ? NaN : Number(item.total_price);
  const price = item.unit_price === null || item.unit_price === undefined ? NaN : Number(item.unit_price);
  if (quantity > 0 && Number.isFinite(total) && total >= 0
      && (!Number.isFinite(price) || Math.abs(quantity * price - total) > Math.max(0.01, Math.abs(total) * 0.000001))) {
    return total / quantity;
  }
  return item.unit_price;
}

async function lookupMappedProduct(pool, userId, supplierId, extractedName, extractedUnit) {
  if (!extractedName || !supplierId) return null;
  const { rows } = await pool.query(
    `
    SELECT p.product_id, p.product_name, p.product_code, p.primary_unit, pm.provider_unit, pm.local_unit,
           pm.conversion_rate_to_local
    FROM productmapping pm
    JOIN product p ON p.product_id = pm.local_product_id
    WHERE p.user_id = $1 AND pm.supplier_id = $2
      AND pm.provider_product_name IS NOT NULL AND LOWER(pm.provider_product_name) = LOWER($3)
      AND (LOWER(COALESCE(pm.provider_unit, '')) = LOWER(COALESCE($4, '')) OR pm.provider_unit IS NULL)
    ORDER BY CASE WHEN LOWER(COALESCE(pm.provider_unit, '')) = LOWER(COALESCE($4, '')) THEN 0
                  WHEN pm.provider_unit IS NULL THEN 1 ELSE 2 END, p.product_id
    LIMIT 1
    `,
    [userId, supplierId, extractedName, extractedUnit],
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
      AND (
        LOWER(TRIM(sm.provider_supplier_name)) = LOWER(TRIM($2))
        OR LOWER(TRIM(s.supplier_name)) = LOWER(TRIM($2))
      )
    ORDER BY
      CASE WHEN LOWER(TRIM(sm.provider_supplier_name)) = LOWER(TRIM($2)) THEN 0 ELSE 1 END,
      s.supplier_id
    LIMIT 1
    `,
    [userId, extractedName],
  );
  return rows[0] || null;
}

async function mapExtractedInvoice(pool, gemini, userId, options = {}) {
  const corresponding = correspondingFromGemini(gemini);
  if (!pool || !userId) return corresponding;

  try {
    const requestedSupplierId = Number(options.supplierId);
    const supplier = Number.isInteger(requestedSupplierId) && requestedSupplierId > 0
      ? (await pool.query(`SELECT supplier_id,supplier_name,phone_number,address FROM supplier WHERE user_id=$1 AND supplier_id=$2`, [userId, requestedSupplierId])).rows[0]
      : await lookupMappedSupplier(pool, userId, gemini.supplier.name);
    if (supplier) corresponding.supplier = {
      ...corresponding.supplier,
      supplier_id: supplier.supplier_id,
      name: supplier.supplier_name,
      phone: supplier.phone_number,
      address: supplier.address,
    };
    for (let index = 0; supplier && index < gemini.items.length; index += 1) {
      const product = await lookupMappedProduct(pool, userId, supplier.supplier_id, gemini.items[index].name, gemini.items[index].unit);
      if (product) {
        corresponding.items[index].product_id = product.product_id;
        corresponding.items[index].name = product.product_name;
        const rate = Number(product.conversion_rate_to_local);
        const extractedQuantity = Number(gemini.items[index].quantity);
        if (Number.isFinite(rate) && rate > 0 && Number.isFinite(extractedQuantity) && extractedQuantity > 0) {
          const convertedQuantity = extractedQuantity * rate;
          const extractedTotal = Number(gemini.items[index].total_price);
          const extractedPrice = Number(gemini.items[index].unit_price);
          corresponding.items[index].quantity = convertedQuantity;
          corresponding.items[index].unit = product.local_unit || product.primary_unit || gemini.items[index].unit;
          corresponding.items[index].unit_price = Number.isFinite(extractedTotal) && extractedTotal >= 0
            ? extractedTotal / convertedQuantity
            : Number.isFinite(extractedPrice) ? extractedPrice / rate : gemini.items[index].unit_price;
          corresponding.items[index].conversion_rate = rate;
        } else {
          const sameUnit = String(product.provider_unit || '').trim().toLocaleLowerCase('vi-VN')
            === String(product.local_unit || '').trim().toLocaleLowerCase('vi-VN');
          corresponding.items[index].unit = sameUnit ? product.local_unit : gemini.items[index].unit;
          corresponding.items[index].conversion_rate = null;
        }
      }
    }
  } catch (error) {
    console.warn('Invoice mapping lookup skipped:', error.message);
  }

  return corresponding;
}

module.exports = { mapExtractedInvoice, correspondingFromGemini };
