const { loadConnectionConfig } = require('./kiotVietConnectionService');
const { calculateInvoiceTax, pricesAfterTax, paidAmountForInvoice } = require('./invoiceTaxService');
const { buildPurchaseOrderPayload, createPurchaseOrder, updatePurchaseOrder } = require('../kiotviet');

function nonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw Object.assign(new Error(`${label} không hợp lệ.`), { statusCode: 400 });
  return number;
}

function cleanText(value, length = 255) { return String(value ?? '').trim().slice(0, length); }

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
  const subtotal = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0);
  const tax = calculateInvoiceTax({ subtotal, discount: Number(invoice.discount_amount || 0), taxMode: 'VND', taxValue: Number(invoice.tax_amount || 0) });
  const paidAmount = paidAmountForInvoice(invoice.paid_amount, tax.totalAfterTax);
  const taxedItems = pricesAfterTax(items.map((item) => ({ productCode: item.product_code, quantity: Number(item.quantity), unitPrice: Number(item.unit_price) })), tax.taxAmount);

  const payload = buildPurchaseOrderPayload({
    branchId: Number(branch.kiotviet_id),
    supplier: { name: invoice.supplier_name, phone: invoice.phone_number, address: invoice.address },
    discount: Number(invoice.discount_amount || 0),
    total: tax.totalAfterTax,
    paidAmount,
    invoiceNumber: invoice.invoice_number,
    items: taxedItems,
  });
  const result = await createPurchaseOrder(await loadConnectionConfig(pool, userId), payload);
  await pool.query(`UPDATE purchaseinvoice SET status='SYNCED', kiotviet_purchase_order_id=$1,
    kiotviet_purchase_order_code=$2 WHERE invoice_id=$3 AND user_id=$4`, [result.id, result.code || null, invoiceId, userId]);
  return { status: 'SYNCED', id: result.id, code: result.code || null };
}

async function updatePurchaseInvoice(pool, userId, invoiceId, body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw Object.assign(new Error('Hóa đơn cần ít nhất một dòng hàng.'), { statusCode: 400 });
  const supplierId = Number(body.supplierId);
  if (!Number.isInteger(supplierId) || supplierId <= 0) throw Object.assign(new Error('Hãy chọn nhà cung cấp đã đồng bộ từ KiotViet.'), { statusCode: 400 });
  const normalized = items.map((item, index) => ({
    productId: Number(item.productId), unit: cleanText(item.unit, 100) || null,
    quantity: nonNegative(item.quantity, `Số lượng dòng ${index + 1}`), unitPrice: nonNegative(item.unitPrice, `Đơn giá dòng ${index + 1}`),
  }));
  if (normalized.some((item) => !Number.isInteger(item.productId) || item.productId <= 0)) throw Object.assign(new Error('Mỗi dòng phải chọn một hàng hóa hợp lệ.'), { statusCode: 400 });
  const discount = nonNegative(body.discountAmount || 0, 'Chiết khấu');
  const invoiceDate = body.invoiceDate ? new Date(body.invoiceDate) : null;
  if (invoiceDate && Number.isNaN(invoiceDate.getTime())) throw Object.assign(new Error('Ngày hóa đơn không hợp lệ.'), { statusCode: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM purchaseinvoice WHERE invoice_id=$1 AND user_id=$2 FOR UPDATE', [invoiceId, userId]);
    if (!current.rowCount) throw Object.assign(new Error('Không tìm thấy hóa đơn.'), { statusCode: 404 });
    const invoice = current.rows[0];
    const supplierResult = await client.query('SELECT supplier_id,supplier_name,phone_number,address FROM supplier WHERE supplier_id=$1 AND user_id=$2', [supplierId, userId]);
    if (!supplierResult.rowCount) throw Object.assign(new Error('Nhà cung cấp không thuộc account hiện tại.'), { statusCode: 403 });
    const productsResult = await client.query('SELECT product_id,product_code FROM product WHERE user_id=$1 AND product_id=ANY($2::int[])', [userId, [...new Set(normalized.map((item) => item.productId))]]);
    if (productsResult.rowCount !== new Set(normalized.map((item) => item.productId)).size || productsResult.rows.some((row) => !row.product_code)) throw Object.assign(new Error('Mọi hàng hóa phải có mã KiotViet.'), { statusCode: 400 });
    const byId = new Map(productsResult.rows.map((row) => [row.product_id, row]));
    const subtotal = normalized.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    if (discount > subtotal) throw Object.assign(new Error('Chiết khấu không được lớn hơn tổng tiền hàng.'), { statusCode: 400 });
    const tax = calculateInvoiceTax({ subtotal, discount, taxMode: body.taxMode, taxValue: body.taxValue });
    const paidAmount = paidAmountForInvoice(body.paidAmount, tax.totalAfterTax);
    const taxedItems = pricesAfterTax(normalized, tax.taxAmount);
    if (invoice.status === 'SYNCED') {
      if (!invoice.kiotviet_purchase_order_id) throw Object.assign(new Error('Thiếu mã phiếu nhập KiotViet; không thể cập nhật an toàn.'), { statusCode: 409 });
      const branch = (await client.query('SELECT kiotviet_id FROM kiotvietbranch WHERE user_id=$1 ORDER BY branch_id LIMIT 1', [userId])).rows[0];
      if (!branch) throw Object.assign(new Error('Chưa có chi nhánh KiotViet. Hãy đồng bộ danh mục trước.'), { statusCode: 409 });
      const payload = buildPurchaseOrderPayload({ branchId: Number(branch.kiotviet_id), supplier: { name: supplierResult.rows[0].supplier_name, phone: supplierResult.rows[0].phone_number, address: supplierResult.rows[0].address }, discount, total: tax.totalAfterTax, paidAmount, invoiceNumber: cleanText(body.invoiceNumber) || null, items: taxedItems.map((item) => ({ productCode: byId.get(item.productId).product_code, quantity: item.quantity, unitPrice: item.unitPrice })) });
      // KiotViet is updated first. If it rejects the update, no local data is changed.
      await updatePurchaseOrder(await loadConnectionConfig(pool, userId), invoice.kiotviet_purchase_order_id, payload);
    }
    await client.query('UPDATE purchaseinvoice SET supplier_id=$1,invoice_date=$2,invoice_number=$3,total_amount=$4,discount_amount=$5,tax_input_mode=$6,tax_rate=$7,tax_amount=$8,paid_amount=$9 WHERE invoice_id=$10 AND user_id=$11', [supplierId, invoiceDate, cleanText(body.invoiceNumber) || null, tax.totalAfterTax, discount, tax.taxMode, tax.taxRate, tax.taxAmount, paidAmount, invoiceId, userId]);
    await client.query('DELETE FROM purchaseinvoiceitem WHERE invoice_id=$1', [invoiceId]);
    for (const item of normalized) await client.query('INSERT INTO purchaseinvoiceitem(invoice_id,product_id,quantity,unit,unit_price,total_price) VALUES($1,$2,$3,$4,$5,$6)', [invoiceId, item.productId, item.quantity, item.unit, item.unitPrice, item.quantity * item.unitPrice]);
    await client.query('COMMIT');
    return { updated: true, status: invoice.status };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

module.exports = { syncPurchaseInvoice, updatePurchaseInvoice };
