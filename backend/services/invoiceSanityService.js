const LAYOUT_TYPES = ['SINGLE_UNIT_COLUMN', 'SPLIT_QUANTITY_COLUMNS', 'FREE_FORM', 'UNKNOWN'];

function parseVisibleMoney(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().toLocaleLowerCase('vi-VN')
    .replace(/(?:vnd|vnđ|đồng|đ|₫)/g, '')
    .replace(/\s+/g, '');
  if (!text) return null;
  const hasThousandSuffix = /(?:k|nghìn|ngàn)$/.test(text);
  text = text.replace(/(?:k|nghìn|ngàn)$/, '');
  if (!/^-?[\d.,]+$/.test(text)) return null;
  const separators = text.match(/[.,]/g) || [];
  let number;
  if (separators.length && /[.,]\d{3}(?:[.,]\d{3})*$/.test(text)) {
    number = Number(text.replace(/[.,]/g, ''));
  } else if (separators.length === 1) {
    number = Number(text.replace(',', '.'));
  } else {
    number = Number(text.replace(/[.,]/g, ''));
  }
  if (!Number.isFinite(number)) return null;
  return number * (hasThousandSuffix ? 1000 : 1);
}

function normalizeScaledValue(value, rawValue, scale) {
  const numeric = value === null || value === undefined ? null : Number(value);
  const raw = parseVisibleMoney(rawValue);
  if (!Number.isFinite(numeric) || !Number.isFinite(raw) || scale !== 1000) return { value, applied: false };
  const rawText = String(rawValue).trim().toLocaleLowerCase('vi-VN').replace(/\s+/g, '');
  const explicitlyScaled = /(?:k|nghìn|ngàn)(?:vnd|vnđ|đồng|đ|₫)?$/.test(rawText)
    || Math.abs(raw) >= 1000
    || /[.,]\d{3}(?:[.,]\d{3})*(?:vnd|vnđ|đồng|đ|₫)?$/.test(rawText);
  // Explicit suffixes and formatted/full amounts are themselves reliable VND evidence.
  if (explicitlyScaled) return closeMoney(numeric, raw)
    ? { value: numeric, applied: false }
    : { value: raw, applied: true };
  if (closeMoney(numeric, raw * 1000)) return { value: numeric, applied: false };
  if (closeMoney(numeric, raw)) return { value: raw * 1000, applied: true };
  return { value, applied: false };
}

function arithmeticMoneyCandidate(item) {
  const quantity = finitePositive(item.quantity);
  const factor = finitePositive(item.package_quantity) || 1;
  const price = finitePositive(item.unit_price);
  const total = finitePositive(item.total_price);
  if (!quantity || !price || !total) return null;
  const multiplier = quantity * factor;
  if (closeMoney(multiplier * price * 1000, total)) return { field: 'unit_price', value: price * 1000 };
  if (closeMoney(multiplier * price, total * 1000)) return { field: 'total_price', value: total * 1000 };
  return null;
}

function normalizeInvoiceMoney(invoice) {
  const normalized = { ...invoice, items: [] };
  const issues = [];
  for (const [index, source] of (invoice.items || []).entries()) {
    const item = { ...source };
    const price = normalizeScaledValue(item.unit_price, item.raw_unit_price, invoice.money_scale);
    const total = normalizeScaledValue(item.total_price, item.raw_total_price, invoice.money_scale);
    item.unit_price = price.value;
    item.total_price = total.value;
    const appliedFields = [];
    if (price.applied) appliedFields.push('đơn giá');
    if (total.applied) appliedFields.push('thành tiền');
    if (!appliedFields.length) {
      const candidate = arithmeticMoneyCandidate(item);
      if (candidate) {
        item[candidate.field] = candidate.value;
        appliedFields.push(candidate.field === 'unit_price' ? 'đơn giá' : 'thành tiền');
      }
    }
    if (appliedFields.length) issues.push({
      code: 'THOUSAND_VND_NORMALIZED', item_index: index, severity: 'info',
      message: `Dòng ${index + 1}: đã chuẩn hóa ${appliedFields.join(' và ')} viết tắt theo đơn vị nghìn đồng.`,
    });
    normalized.items.push(item);
  }
  const totalAmount = normalizeScaledValue(invoice.total_amount, invoice.raw_total_amount, invoice.money_scale);
  normalized.total_amount = totalAmount.value;
  let totalApplied = totalAmount.applied;
  if (!totalApplied && finitePositive(normalized.total_amount)) {
    const itemTotal = normalized.items
      .filter((item) => item.line_status !== 'CANCELLED')
      .reduce((sum, item) => sum + (finitePositive(item.total_price) || 0), 0);
    if (itemTotal > 0 && closeMoney(normalized.total_amount * 1000, itemTotal)) {
      normalized.total_amount *= 1000;
      totalApplied = true;
    }
  }
  if (totalApplied) issues.push({
    code: 'THOUSAND_VND_TOTAL_NORMALIZED', severity: 'info',
    message: 'Đã chuẩn hóa tổng tiền viết tắt theo đơn vị nghìn đồng.',
  });
  return { invoice: normalized, issues };
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedText(value) {
  return String(value || '').trim().toLocaleLowerCase('vi-VN').replace(/\s+/g, ' ');
}

function closeMoney(actual, expected) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  // Printed invoices can contain rounding. Keep the tolerance relative but small.
  return Math.abs(actual - expected) <= Math.max(5, Math.abs(expected) * 0.001);
}

function normalizeCells(cells) {
  if (!Array.isArray(cells)) return [];
  return cells.map((cell) => ({
    sub_header: typeof cell?.sub_header === 'string' ? cell.sub_header.trim() || null : null,
    value: cell?.value === null || cell?.value === undefined ? null : Number(cell.value),
  })).filter((cell) => cell.sub_header || Number.isFinite(cell.value));
}

function inspectLine(item, index) {
  const normalized = { ...item, quantity_cells: normalizeCells(item.quantity_cells) };
  const issues = [];
  const activeCells = normalized.quantity_cells.filter((cell) => finitePositive(cell.value));
  const quantity = finitePositive(item.quantity);
  const unitPrice = finitePositive(item.unit_price);
  const total = finitePositive(item.total_price);
  const factor = finitePositive(item.package_quantity);

  if (activeCells.length === 1) {
    const active = activeCells[0];
    if (active.sub_header && normalizedText(active.sub_header) !== normalizedText(item.unit)) {
      normalized.quantity = active.value;
      normalized.unit = active.sub_header;
      issues.push({
        code: 'UNIT_COLUMN_MISMATCH',
        item_index: index,
        severity: 'warning',
        message: `Dòng ${index + 1}: ô số lượng có giá trị nằm dưới cột “${active.sub_header}”; đây là đơn vị chuẩn hóa đề xuất.`,
      });
    }
  } else if (activeCells.length > 1) {
    issues.push({
      code: 'MULTIPLE_QUANTITY_CELLS',
      item_index: index,
      severity: 'warning',
      message: `Dòng ${index + 1}: có nhiều cột số lượng cùng có giá trị; cần kiểm tra cách quy đổi.`,
    });
  }

  const checkedQuantity = finitePositive(normalized.quantity) || quantity;
  if (checkedQuantity && unitPrice && total) {
    const directMatches = closeMoney(checkedQuantity * unitPrice, total);
    const packagedMatches = factor ? closeMoney(checkedQuantity * factor * unitPrice, total) : false;
    if (!directMatches && packagedMatches) {
      issues.push({
        code: 'PACKAGE_TOTAL_MATCH',
        item_index: index,
        severity: 'info',
        message: `Dòng ${index + 1}: thành tiền khớp số lượng × quy cách × đơn giá; đơn giá có thể áp dụng cho đơn vị con.`,
      });
    } else if (!directMatches && !packagedMatches) {
      issues.push({
        code: 'TOTAL_MISMATCH',
        item_index: index,
        severity: 'warning',
        message: `Dòng ${index + 1}: số lượng, quy cách, đơn giá và thành tiền chưa khớp nhau.`,
      });
    }
  }

  return { item: normalized, issues };
}

function inspectInvoice(invoice) {
  const money = normalizeInvoiceMoney(invoice);
  const items = [];
  const issues = [...money.issues];
  for (const [index, item] of (money.invoice.items || []).entries()) {
    const inspected = inspectLine(item, index);
    items.push(inspected.item);
    issues.push(...inspected.issues);
  }
  const normalized = {
    ...money.invoice,
    layout_type: LAYOUT_TYPES.includes(money.invoice.layout_type) ? money.invoice.layout_type : 'UNKNOWN',
    items,
  };
  return {
    invoice: normalized,
    issues,
    needsVerification: issues.some((issue) => ['UNIT_COLUMN_MISMATCH', 'MULTIPLE_QUANTITY_CELLS', 'TOTAL_MISMATCH'].includes(issue.code)),
  };
}

function comparisonShape(invoice) {
  return {
    document_type: invoice.document_type,
    legibility: invoice.legibility,
    layout_type: invoice.layout_type,
    items: (invoice.items || []).map((item) => ({
      name: normalizedText(item.name),
      quantity: item.quantity,
      unit: normalizedText(item.unit),
      quantity_cells: normalizeCells(item.quantity_cells).map((cell) => ({
        sub_header: normalizedText(cell.sub_header), value: cell.value,
      })),
      package_quantity: item.package_quantity,
      package_unit: normalizedText(item.package_unit),
      unit_price: item.unit_price,
      price_unit: normalizedText(item.price_unit),
      total_price: item.total_price,
    })),
  };
}

function readingsAgree(first, second) {
  return JSON.stringify(comparisonShape(first)) === JSON.stringify(comparisonShape(second));
}

module.exports = { inspectInvoice, readingsAgree, closeMoney, parseVisibleMoney, normalizeInvoiceMoney };
