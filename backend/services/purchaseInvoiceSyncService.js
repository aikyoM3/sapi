const { loadConnectionConfig } = require('./kiotVietConnectionService');
const { buildPurchaseOrderPayload, createPurchaseOrder } = require('../kiotviet');

async function syncPurchaseInvoice(pool, userId, invoiceId) {
  const invoiceResult = await pool.query(`
    SELECT pi.*, s.supplier_name, s.phone_number, s.address
    FROM purchaseinvoice pi
    LEFT JOIN supplier s ON s.supplier_id=pi.supplier_id AND s.user_id=pi.user_id
    WHERE pi.invoice_id=$1 AND pi.user_id=$2
  `, [invoiceId, userId]);
  const invoice = invoiceResult.rows[0];
  if (!invoice) throw Object.assign(new Error('Không tìm thấy hóa đơn.'), { statusCode: 404 });
  if (invoice.status === 'SYNCED') return { status: 'SYNCED', id: invoice.kiotviet_purchase_order_id, code: invoice.kiotviet_purchase_order_code };

  const { rows: items } = await pool.query(`
    SELECT pii.quantity, pii.unit_price, p.product_code
    FROM purchaseinvoiceitem pii JOIN product p ON p.product_id=pii.product_id
    WHERE pii.invoice_id=$1
  `, [invoiceId]);
  if (!items.length || items.some((item) => !item.product_code)) {
    throw Object.assign(new Error('Hóa đơn có hàng hóa chưa có mã KiotViet.'), { statusCode: 400 });
  }
  const branch = (await pool.query('SELECT kiotviet_id FROM kiotvietbranch WHERE user_id=$1 ORDER BY branch_id LIMIT 1', [userId])).rows[0];
  if (!branch) throw Object.assign(new Error('Chưa có chi nhánh KiotViet. Hãy đồng bộ dữ liệu trước.'), { statusCode: 409 });

  const payload = buildPurchaseOrderPayload({
    branchId: Number(branch.kiotviet_id),
    supplier: { name: invoice.supplier_name, phone: invoice.phone_number, address: invoice.address },
    purchaseDate: invoice.invoice_date ? new Date(invoice.invoice_date) : new Date(),
    discount: Number(invoice.discount_amount || 0),
    total: Number(invoice.total_amount),
    invoiceNumber: invoice.invoice_number,
    items: items.map((item) => ({ productCode: item.product_code, quantity: Number(item.quantity), unitPrice: Number(item.unit_price) })),
  });
  const result = await createPurchaseOrder(await loadConnectionConfig(pool, userId), payload);
  await pool.query(`UPDATE purchaseinvoice SET status='SYNCED', kiotviet_purchase_order_id=$1,
    kiotviet_purchase_order_code=$2 WHERE invoice_id=$3 AND user_id=$4`, [result.id, result.code || null, invoiceId, userId]);
  return { status: 'SYNCED', id: result.id, code: result.code || null };
}

module.exports = { syncPurchaseInvoice };
