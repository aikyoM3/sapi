function taxError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function calculateInvoiceTax({ subtotal, discount = 0, taxMode = 'PERCENT', taxValue = 0 }) {
  const gross = Number(subtotal);
  const discountAmount = Number(discount);
  const input = taxValue === '' || taxValue === null || taxValue === undefined ? 0 : Number(taxValue);
  const mode = String(taxMode || 'PERCENT').trim().toUpperCase();
  if (!Number.isFinite(gross) || gross < 0 || !Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > gross) throw taxError('Tổng tiền hoặc chiết khấu không hợp lệ.');
  if (!['PERCENT', 'VND'].includes(mode)) throw taxError('Đơn vị thuế chỉ nhận % hoặc VND.');
  if (!Number.isFinite(input) || input < 0) throw taxError('Thuế không hợp lệ.');
  const taxableAmount = roundMoney(gross - discountAmount);
  if (mode === 'PERCENT' && input > 100) throw taxError('Thuế phần trăm phải nằm trong khoảng 0–100%.');
  if (mode === 'VND' && taxableAmount === 0 && input > 0) throw taxError('Không thể áp dụng tiền thuế khi giá trị tính thuế bằng 0.');
  const taxAmount = roundMoney(mode === 'PERCENT' ? taxableAmount * input / 100 : input);
  const taxRate = taxableAmount > 0 ? taxAmount / taxableAmount * 100 : 0;
  return { taxMode: mode, taxInputValue: input, taxableAmount, taxRate, taxAmount, totalAfterTax: roundMoney(taxableAmount + taxAmount) };
}

function pricesAfterTax(items, taxAmount) {
  const normalized = items.map((item) => ({ ...item, quantity: Number(item.quantity), unitPrice: Number(item.unitPrice) }));
  const subtotal = normalized.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const tax = roundMoney(taxAmount);
  if (!tax || subtotal <= 0) return normalized;
  let remaining = tax;
  const eligible = normalized.map((item, index) => ({ index, base: item.quantity * item.unitPrice })).filter((item) => item.base > 0);
  return normalized.map((item, index) => {
    const eligibleIndex = eligible.findIndex((entry) => entry.index === index);
    if (eligibleIndex < 0) return item;
    const allocated = eligibleIndex === eligible.length - 1 ? remaining : roundMoney(tax * eligible[eligibleIndex].base / subtotal);
    remaining = roundMoney(remaining - allocated);
    return { ...item, unitPrice: item.unitPrice + allocated / item.quantity };
  });
}

function paidAmountForInvoice(value, totalAfterTax) {
  const total = Number(totalAfterTax);
  const paid = value === '' || value === null || value === undefined ? total : Number(value);
  if (!Number.isFinite(paid) || paid < 0 || paid > total) throw taxError('Tiền trả nhà cung cấp phải nằm trong khoảng từ 0 đến tổng thanh toán.');
  return roundMoney(paid);
}

module.exports = { calculateInvoiceTax, pricesAfterTax, paidAmountForInvoice };
