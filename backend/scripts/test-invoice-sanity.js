const assert = require('node:assert/strict');
const { inspectInvoice, readingsAgree } = require('../services/invoiceSanityService');
const { shouldVerifyInspection } = require('../services/invoiceSessionProcessingService');

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
assert.equal(shouldVerifyInspection(first, { document_type: 'PRINTED' }), true);
assert.equal(shouldVerifyInspection(first, { document_type: 'HANDWRITTEN' }), false);
assert.equal(shouldVerifyInspection(first, { document_type: 'MIXED' }), false);

const mixed = structuredClone(invoice);
mixed.items[0].quantity_cells = [{ sub_header: 'Thùng', value: 2 }, { sub_header: 'Lẻ', value: 5 }];
const mixedResult = inspectInvoice(mixed);
assert(mixedResult.issues.some((issue) => issue.code === 'MULTIPLE_QUANTITY_CELLS'));

const thousandInvoice = {
  document_type: 'HANDWRITTEN', layout_type: 'FREE_FORM', money_scale: 1000,
  total_amount: 24, raw_total_amount: '24',
  items: [{ name: 'Bánh', quantity: 2, unit: 'Cái', quantity_cells: [], package_quantity: null,
    unit_price: 12, raw_unit_price: '12', total_price: 24, raw_total_price: '24' }],
};
const thousandResult = inspectInvoice(thousandInvoice);
assert.equal(thousandResult.invoice.items[0].unit_price, 12000);
assert.equal(thousandResult.invoice.items[0].total_price, 24000);
assert.equal(thousandResult.invoice.total_amount, 24000);
assert(thousandResult.issues.some((issue) => issue.code === 'THOUSAND_VND_NORMALIZED'));

const alreadyNormalized = structuredClone(thousandInvoice);
alreadyNormalized.items[0].unit_price = 12000;
alreadyNormalized.items[0].total_price = 24000;
alreadyNormalized.total_amount = 24000;
const preserved = inspectInvoice(alreadyNormalized);
assert.equal(preserved.invoice.items[0].unit_price, 12000);
assert.equal(preserved.invoice.items[0].total_price, 24000);

const explicitSuffix = structuredClone(thousandInvoice);
explicitSuffix.items[0].unit_price = 12000;
explicitSuffix.items[0].raw_unit_price = '12k';
const suffixResult = inspectInvoice(explicitSuffix);
assert.equal(suffixResult.invoice.items[0].unit_price, 12000);

const formattedRaw = structuredClone(thousandInvoice);
formattedRaw.items[0].unit_price = 12;
formattedRaw.items[0].raw_unit_price = '12.000đ';
const formattedResult = inspectInvoice(formattedRaw);
assert.equal(formattedResult.invoice.items[0].unit_price, 12000);

const unknownScale = structuredClone(thousandInvoice);
unknownScale.money_scale = null;
const uncertain = inspectInvoice(unknownScale);
assert.equal(uncertain.invoice.items[0].unit_price, 12);
assert.equal(uncertain.invoice.items[0].total_price, 24);

const arithmeticEvidence = structuredClone(thousandInvoice);
arithmeticEvidence.money_scale = null;
arithmeticEvidence.items[0].total_price = 24000;
arithmeticEvidence.items[0].raw_total_price = '24.000';
const arithmeticResult = inspectInvoice(arithmeticEvidence);
assert.equal(arithmeticResult.invoice.items[0].unit_price, 12000);
assert.equal(arithmeticResult.invoice.items[0].total_price, 24000);

const inferredInvoiceTotal = structuredClone(arithmeticEvidence);
inferredInvoiceTotal.total_amount = 24;
inferredInvoiceTotal.raw_total_amount = null;
const inferredTotalResult = inspectInvoice(inferredInvoiceTotal);
assert.equal(inferredTotalResult.invoice.total_amount, 24000);

console.log('PASS: invoice sanity handles units, package totals, disagreements and guarded thousand-VND normalization.');
