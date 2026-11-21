const assert = require('node:assert/strict');
const { calculateInvoiceTax, pricesAfterTax, paidAmountForInvoice } = require('../services/invoiceTaxService');

const percent = calculateInvoiceTax({ subtotal: 1000, discount: 100, taxMode: 'PERCENT', taxValue: 10 });
assert.deepEqual(percent, { taxMode: 'PERCENT', taxInputValue: 10, taxableAmount: 900, taxRate: 10, taxAmount: 90, totalAfterTax: 990 });

const vnd = calculateInvoiceTax({ subtotal: 1000, discount: 100, taxMode: 'VND', taxValue: 90 });
assert.equal(vnd.taxRate, 10);
assert.equal(vnd.totalAfterTax, 990);

const items = pricesAfterTax([
  { productCode: 'A', quantity: 1, unitPrice: 600 },
  { productCode: 'B', quantity: 2, unitPrice: 200 },
], 90);
const afterTaxSubtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
assert.equal(afterTaxSubtotal, 1090);
assert.equal(afterTaxSubtotal - 100, percent.totalAfterTax);
assert.throws(() => calculateInvoiceTax({ subtotal: 100, taxMode: 'PERCENT', taxValue: 101 }), /0–100/);
assert.throws(() => calculateInvoiceTax({ subtotal: 0, taxMode: 'VND', taxValue: 1 }), /bằng 0/);
assert.equal(paidAmountForInvoice('', 990), 990);
assert.equal(paidAmountForInvoice(500, 990), 500);
assert.throws(() => paidAmountForInvoice(1000, 990), /tổng thanh toán/);

console.log('PASS: percent/VND conversion, discount tax base, allocation and validation.');
