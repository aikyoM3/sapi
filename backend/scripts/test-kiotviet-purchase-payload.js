const assert = require('node:assert/strict');
const { buildPurchaseOrderPayload } = require('../kiotviet');

const before = Date.now();
const payload = buildPurchaseOrderPayload({
  branchId: 1,
  supplier: { name: 'Offline supplier' },
  discount: 0,
  total: 100,
  invoiceNumber: 'OFFLINE',
  items: [{ productCode: 'OFFLINE', quantity: 1, unitPrice: 100 }],
});
const after = Date.now();

assert.equal(payload.isDraft, 0);
assert(Date.parse(payload.purchaseDate) >= before && Date.parse(payload.purchaseDate) <= after);
console.log('PASS: KiotViet purchase receipt is finalized and uses the send timestamp.');
