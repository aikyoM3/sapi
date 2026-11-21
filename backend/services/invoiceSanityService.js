const LAYOUT_TYPES = ['SINGLE_UNIT_COLUMN', 'SPLIT_QUANTITY_COLUMNS', 'FREE_FORM', 'UNKNOWN'];

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
  const items = [];
  const issues = [];
  for (const [index, item] of (invoice.items || []).entries()) {
    const inspected = inspectLine(item, index);
    items.push(inspected.item);
    issues.push(...inspected.issues);
  }
  const normalized = {
    ...invoice,
    layout_type: LAYOUT_TYPES.includes(invoice.layout_type) ? invoice.layout_type : 'UNKNOWN',
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

module.exports = { inspectInvoice, readingsAgree, closeMoney };
