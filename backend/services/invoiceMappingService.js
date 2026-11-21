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

function normalizedMappingText(value) {
  return String(value || '')
    .toLocaleLowerCase('vi-VN')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/([a-z])(\d)|(\d)([a-z])/g, (_match, a, b, c, d) => `${a || c} ${b || d}`)
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function mappingTokens(value) {
  const normalized = normalizedMappingText(value);
  return normalized ? [...new Set(normalized.split(' '))] : [];
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]; previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal : Math.min(diagonal, above, previous[rightIndex - 1]) + 1;
      diagonal = above;
    }
  }
  return previous[right.length];
}

function fuzzyMappingScore(left, right) {
  const leftText = normalizedMappingText(left); const rightText = normalizedMappingText(right);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 1;
  const leftTokens = mappingTokens(leftText); const rightTokens = mappingTokens(rightText);
  const leftNumbers = leftTokens.filter((token) => /^\d+$/.test(token)).sort();
  const rightNumbers = rightTokens.filter((token) => /^\d+$/.test(token)).sort();
  // Numbers carry product size/package identity. Any difference is unsafe:
  // e.g. the otherwise similar Milo 180 ml and Milo 110 ml.
  if (JSON.stringify(leftNumbers) !== JSON.stringify(rightNumbers)) return 0;
  const identityUnits = new Set(['ml', 'cl', 'l', 'lit', 'mg', 'g', 'gr', 'gram', 'kg', 'chai', 'goi', 'tui', 'thung', 'hop']);
  const leftUnits = leftTokens.filter((token) => identityUnits.has(token)).sort();
  const rightUnits = rightTokens.filter((token) => identityUnits.has(token)).sort();
  if (JSON.stringify(leftUnits) !== JSON.stringify(rightUnits)) return 0;
  const rightSet = new Set(rightTokens);
  const intersection = leftTokens.filter((token) => rightSet.has(token)).length;
  const tokenDice = (2 * intersection) / (leftTokens.length + rightTokens.length);
  const charSimilarity = 1 - levenshteinDistance(leftText, rightText) / Math.max(leftText.length, rightText.length);
  return tokenDice * 0.7 + charSimilarity * 0.3;
}

function chooseTolerantMapping(rows, extractedName) {
  const target = normalizedMappingText(extractedName);
  const exact = rows.find((row) => normalizedMappingText(row.provider_product_name) === target);
  if (exact) return { ...exact, mapping_match_type: 'EXACT', mapping_score: 1 };
  const bestByProduct = new Map();
  for (const row of rows) {
    const score = fuzzyMappingScore(row.provider_product_name, extractedName);
    const current = bestByProduct.get(String(row.product_id));
    if (!current || score > current.score) bestByProduct.set(String(row.product_id), { row, score });
  }
  const ranked = [...bestByProduct.values()].sort((left, right) => right.score - left.score);
  const best = ranked[0]; const runnerUp = ranked[1];
  if (!best || best.score < 0.82 || (runnerUp && best.score - runnerUp.score < 0.06)) return null;
  return { ...best.row, mapping_match_type: 'FUZZY', mapping_score: best.score };
}

async function lookupMappedProduct(pool, userId, supplierId, extractedName, extractedUnit) {
  if (!extractedName || !supplierId) return null;
  const { rows } = await pool.query(
    `
    SELECT p.product_id, p.product_name, p.product_code, p.primary_unit, pm.provider_product_name,
           pm.provider_unit, pm.local_unit,
           pm.conversion_rate_to_local
    FROM productmapping pm
    JOIN product p ON p.product_id = pm.local_product_id
    WHERE p.user_id = $1 AND pm.supplier_id = $2
      AND pm.provider_product_name IS NOT NULL
      AND (LOWER(COALESCE(pm.provider_unit, '')) = LOWER(COALESCE($4, '')) OR pm.provider_unit IS NULL)
    ORDER BY CASE WHEN LOWER(TRIM(pm.provider_product_name)) = LOWER(TRIM($3)) THEN 0 ELSE 1 END,
             CASE WHEN LOWER(COALESCE(pm.provider_unit, '')) = LOWER(COALESCE($4, '')) THEN 0
                  WHEN pm.provider_unit IS NULL THEN 1 ELSE 2 END, p.product_id
    LIMIT 500
    `,
    [userId, supplierId, extractedName, extractedUnit],
  );
  return chooseTolerantMapping(rows, extractedName);
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
        corresponding.items[index].mapping_match_type = product.mapping_match_type;
        corresponding.items[index].mapping_score = product.mapping_score;
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

module.exports = {
  mapExtractedInvoice, correspondingFromGemini,
  normalizedMappingText, fuzzyMappingScore, chooseTolerantMapping,
};
