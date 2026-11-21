const assert = require('node:assert/strict');
const { mapExtractedInvoice } = require('../services/invoiceMappingService');

const invoice = (quantity, total) => ({
  supplier: { name: 'Nhà cung cấp A' },
  invoice: { number: null, date: null },
  items: [{ name: 'Nước ngọt X', quantity, unit: 'Thùng', unit_price: total / quantity, total_price: total }],
  promotions: [],
  total_amount: total,
});

function poolWithMapping(conversionRate) {
  return {
    async query(sql) {
      if (sql.includes('FROM supplier s')) return { rows: [{ supplier_id: 10, supplier_name: 'Nhà cung cấp A' }] };
      if (sql.includes('FROM productmapping pm')) return { rows: [{
        product_id: 20,
        product_name: 'Nước ngọt X',
        provider_product_name: 'Nước ngọt X',
        primary_unit: 'Chai',
        provider_unit: 'Thùng',
        local_unit: 'Chai',
        conversion_rate_to_local: conversionRate,
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

(async () => {
  const converted = await mapExtractedInvoice(poolWithMapping(24), invoice(3, 720000), 1);
  assert.equal(converted.items[0].product_id, 20);
  assert.equal(converted.items[0].quantity, 72);
  assert.equal(converted.items[0].unit, 'Chai');
  assert.equal(converted.items[0].unit_price, 10000);
  assert.equal(converted.items[0].conversion_rate, 24);

  const notConfirmed = await mapExtractedInvoice(poolWithMapping(null), invoice(3, 720000), 1);
  assert.equal(notConfirmed.items[0].quantity, 3);
  assert.equal(notConfirmed.items[0].unit, 'Thùng');
  assert.equal(notConfirmed.items[0].conversion_rate, null);

  console.log('PASS: confirmed 1 Thùng = 24 Chai converts 3 Thùng to 72 Chai; unconfirmed unit changes are not applied.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
