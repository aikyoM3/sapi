const express = require('express');
const { currentUserId } = require('../middleware/auth');
const { syncPurchaseInvoice, updatePurchaseInvoice } = require('../services/purchaseInvoiceSyncService');
const { getMobileBaseUrl } = require('../services/lanAddress');
const { KiotVietError } = require('../kiotviet');

const router = express.Router();
const searchTerm = (value) => String(value || '').trim().slice(0, 100);
const textField = (value, max = 255) => String(value ?? '').trim().slice(0, max);

module.exports = function dataRoutes(pool) {
  router.get('/network/status', (_req, res, next) => {
    try { res.json({ mobileBaseUrl: getMobileBaseUrl() }); } catch (error) { next(error); }
  });
  router.get('/invoices', async (req, res, next) => {
    try {
      const query = searchTerm(req.query.q);
      const status = String(req.query.status || '').trim().toUpperCase();
      const dateFrom = String(req.query.dateFrom || '').trim() || null;
      const dateTo = String(req.query.dateTo || '').trim() || null;
      const { rows } = await pool.query(`
        WITH invoice_rows AS (
        SELECT pi.invoice_id, pi.invoice_number, s.supplier_name, pi.invoice_date,
               pi.total_amount, pi.discount_amount, pi.status, NULL::text AS session_token, NULL::text AS session_status,
               NULL::text AS error_message
        FROM purchaseinvoice pi
        LEFT JOIN supplier s ON s.supplier_id = pi.supplier_id AND s.user_id = pi.user_id
        WHERE pi.user_id = $1
        UNION ALL
        SELECT NULL, COALESCE(ins.ocr_result->'gemini'->'invoice'->>'number', image.original_name, 'Ảnh hóa đơn'),
               ins.ocr_result->'gemini'->'supplier'->>'name',
               ins.created_at::date, NULL, 0, ins.status, ins.session_token, ins.status, ins.error_message
        FROM invoicesession ins
        LEFT JOIN LATERAL (
          SELECT original_name FROM invoicesessionimage
          WHERE invoice_session_id=ins.invoice_session_id ORDER BY page_number LIMIT 1
        ) image ON TRUE
        WHERE ins.user_id=$1 AND ins.status IN ('QUEUED','PROCESSING','RETRY_WAIT','READY_FOR_REVIEW','FAILED')
        )
        SELECT * FROM invoice_rows
        WHERE ($2 = '' OR COALESCE(invoice_number,'') ILIKE '%' || $2 || '%'
          OR COALESCE(supplier_name,'') ILIKE '%' || $2 || '%')
          AND ($3 = '' OR status = $3)
          AND ($4::date IS NULL OR invoice_date >= $4::date)
          AND ($5::date IS NULL OR invoice_date <= $5::date)
        ORDER BY invoice_date DESC NULLS LAST, invoice_id DESC NULLS LAST
      `, [currentUserId(req), query, status, dateFrom, dateTo]);
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.get('/invoices/:id', async (req, res, next) => {
    try {
      const invoice = await pool.query(`SELECT pi.invoice_id,pi.invoice_number,pi.invoice_date,pi.total_amount,
        pi.discount_amount,pi.status,pi.kiotviet_purchase_order_code,s.supplier_name
        FROM purchaseinvoice pi LEFT JOIN supplier s ON s.supplier_id=pi.supplier_id
        WHERE pi.invoice_id=$1 AND pi.user_id=$2`, [req.params.id, currentUserId(req)]);
      if (!invoice.rowCount) return res.status(404).json({ error: 'Không tìm thấy hóa đơn.' });
      const items = await pool.query(`SELECT p.product_id,p.product_code,p.product_name,pii.quantity,pii.unit,pii.unit_price,pii.total_price
        FROM purchaseinvoiceitem pii JOIN product p ON p.product_id=pii.product_id WHERE pii.invoice_id=$1`, [req.params.id]);
      res.json({ ...invoice.rows[0], items: items.rows });
    } catch (error) { next(error); }
  });

  router.put('/invoices/:id', async (req, res, next) => {
    try { res.json(await updatePurchaseInvoice(pool, currentUserId(req), Number(req.params.id), req.body || {})); }
    catch (error) { next(error); }
  });

  router.post('/invoices/:id/sync', async (req, res, next) => {
    try { res.json(await syncPurchaseInvoice(pool, currentUserId(req), Number(req.params.id))); }
    catch (error) {
      if (!(error instanceof KiotVietError)) return next(error);
      const code = error.code === 'AUTH' ? 'KIOTVIET_AUTH_FAILED'
        : error.code === 'ACCOUNT_EXPIRED' ? 'KIOTVIET_ACCOUNT_EXPIRED'
        : error.code === 'RETAILER' ? 'KIOTVIET_PERMISSION_DENIED' : 'KIOTVIET_CONNECTION_ERROR';
      res.status(error.statusCode || 502).json({ error: error.message, code });
    }
  });

  router.delete('/invoices/:id', async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invoice = await client.query('SELECT status FROM purchaseinvoice WHERE invoice_id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, currentUserId(req)]);
      if (!invoice.rowCount) throw Object.assign(new Error('Không tìm thấy hóa đơn.'), { statusCode: 404 });
      if (invoice.rows[0].status !== 'PENDING_SYNC') throw Object.assign(new Error('Chỉ có thể hủy hóa đơn chưa đồng bộ.'), { statusCode: 409 });
      await client.query('DELETE FROM purchaseinvoiceitem WHERE invoice_id=$1', [req.params.id]);
      await client.query('DELETE FROM purchaseinvoice WHERE invoice_id=$1 AND user_id=$2', [req.params.id, currentUserId(req)]);
      await client.query('COMMIT'); res.status(204).end();
    } catch (error) { await client.query('ROLLBACK'); next(error); }
    finally { client.release(); }
  });

  router.get('/products', async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT product_id, product_code, product_name, primary_unit, quantity
        FROM product WHERE user_id = $1 ORDER BY product_id
      `, [currentUserId(req)]);
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.get('/products/search', async (req, res, next) => {
    try {
      const query = searchTerm(req.query.q);
      if (query.length < 2) return res.json([]);
      const { rows } = await pool.query(`
        SELECT p.product_id, p.product_code, p.product_name, p.primary_unit,
               ARRAY_REMOVE(ARRAY_AGG(DISTINCT pm.provider_product_name), NULL) AS matched_external_names
        FROM product p
        LEFT JOIN productmapping pm ON pm.local_product_id = p.product_id
        WHERE p.user_id = $1
          AND (p.product_name ILIKE '%' || $2 || '%'
            OR p.product_code ILIKE '%' || $2 || '%'
            OR pm.provider_product_name ILIKE '%' || $2 || '%')
        GROUP BY p.product_id
        ORDER BY CASE WHEN p.product_name ILIKE $2 || '%' THEN 0 ELSE 1 END, p.product_name
        LIMIT 12
      `, [currentUserId(req), query]);
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.get('/suppliers', async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT supplier_id, supplier_name, phone_number, address
        FROM supplier WHERE user_id = $1 ORDER BY supplier_id
      `, [currentUserId(req)]);
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.get('/suppliers/search', async (req, res, next) => {
    try {
      const query = searchTerm(req.query.q);
      if (query.length < 2) return res.json([]);
      const { rows } = await pool.query(`
        SELECT DISTINCT s.supplier_id, s.supplier_name, s.phone_number, s.address
        FROM supplier s
        LEFT JOIN suppliermapping sm ON sm.local_supplier_id = s.supplier_id
        WHERE s.user_id = $1
          AND (s.supplier_name ILIKE '%' || $2 || '%' OR sm.provider_supplier_name ILIKE '%' || $2 || '%')
        ORDER BY s.supplier_name LIMIT 12
      `, [currentUserId(req), query]);
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.get('/product-mappings', async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT pm.mapping_id, s.supplier_name, p.product_name AS local_product_name,
               pm.provider_product_code, pm.provider_product_name, pm.provider_unit, pm.local_unit
        FROM productmapping pm
        JOIN product p ON p.product_id = pm.local_product_id AND p.user_id = $1
        LEFT JOIN supplier s ON s.supplier_id = pm.supplier_id AND s.user_id = $1
        ORDER BY pm.mapping_id
      `, [currentUserId(req)]);
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.put('/product-mappings/:id', async (req, res, next) => {
    try {
      const result = await pool.query(`UPDATE productmapping pm SET provider_product_code=$1,provider_product_name=$2,
        provider_unit=$3,local_unit=$4 FROM product p WHERE pm.mapping_id=$5 AND pm.local_product_id=p.product_id
        AND p.user_id=$6 RETURNING pm.mapping_id`, [textField(req.body.providerProductCode) || null, textField(req.body.providerProductName) || null, textField(req.body.providerUnit, 100) || null, textField(req.body.localUnit, 100) || null, req.params.id, currentUserId(req)]);
      if (!result.rowCount) return res.status(404).json({ error: 'Không tìm thấy dữ liệu đối chiếu.' }); res.json({ updated: true });
    } catch (error) { next(error); }
  });

  router.get('/supplier-mappings', async (req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT sm.supplier_mapping_id, s.supplier_name AS local_supplier_name, sm.provider_supplier_name
        FROM suppliermapping sm JOIN supplier s ON s.supplier_id=sm.local_supplier_id
        WHERE s.user_id=$1 ORDER BY sm.supplier_mapping_id
      `, [currentUserId(req)]);
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.put('/supplier-mappings/:id', async (req, res, next) => {
    try {
      const externalName = textField(req.body.providerSupplierName);
      if (!externalName) return res.status(400).json({ error: 'Tên nhà cung cấp trên hóa đơn là bắt buộc.' });
      const result = await pool.query(`
        UPDATE suppliermapping sm SET provider_supplier_name=$1
        FROM supplier s WHERE sm.supplier_mapping_id=$2 AND s.supplier_id=sm.local_supplier_id AND s.user_id=$3
        RETURNING sm.supplier_mapping_id
      `, [externalName, req.params.id, currentUserId(req)]);
      if (!result.rowCount) return res.status(404).json({ error: 'Không tìm thấy dữ liệu đối chiếu nhà cung cấp.' });
      res.json({ updated: true });
    } catch (error) { next(error); }
  });

  return router;
};
