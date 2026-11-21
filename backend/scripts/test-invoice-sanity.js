const assert = require('node:assert/strict');
const { inspectInvoice, readingsAgree } = require('../services/invoiceSanityService');

const invoice = {
  layout_type: 'SPLIT_QUANTITY_COLUMNS',
  items: [{
    name: 'Mì', quantity: 10, unit: 'Lẻ',
    raw_unit_column: null,
    quantity_cells: [{ sub_header: 'Thùng', value: 10 }, { sub_header: 'Lẻ', value: null }],
    package_quantity: 30, package_unit: 'Lẻ', unit_price: 2587, price_unit: 'Lẻ', total_price: 776100,
  }],
};

const first = inspectInvoice(invoice);
assert.equal(first.invoice.items[0].unit, 'Thùng');
assert.equal(first.invoice.items[0].quantity, 10);
assert(first.issues.some((issue) => issue.code === 'UNIT_COLUMN_MISMATCH'));
assert(first.issues.some((issue) => issue.code === 'PACKAGE_TOTAL_MATCH'));
assert.equal(first.needsVerification, true);
assert.equal(readingsAgree(first.invoice, inspectInvoice(structuredClone(invoice)).invoice), true);

const different = structuredClone(invoice);
different.items[0].quantity_cells = [{ sub_header: 'Thùng', value: null }, { sub_header: 'Lẻ', value: 10 }];
assert.equal(readingsAgree(first.invoice, inspectInvoice(different).invoice), false);

const mixed = structuredClone(invoice);
mixed.items[0].quantity_cells = [{ sub_header: 'Thùng', value: 2 }, { sub_header: 'Lẻ', value: 5 }];
const mixedResult = inspectInvoice(mixed);
assert(mixedResult.issues.some((issue) => issue.code === 'MULTIPLE_QUANTITY_CELLS'));

console.log('PASS: invoice sanity detects split-column units, package totals, disagreements and ambiguous mixed quantities.');
