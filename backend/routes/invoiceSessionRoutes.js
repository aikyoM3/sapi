const crypto = require('crypto');
const fs = require('fs/promises');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { extractInvoiceFromImages, GeminiInvoiceError } = require('../services/geminiInvoiceService');
const { mapExtractedInvoice } = require('../services/invoiceMappingService');
const { saveTemporaryImage, removeTemporaryImages } = require('../services/imageFileService');
const { requireAuth, currentUserId } = require('../middleware/auth');
const { getMobileBaseUrl } = require('../services/lanAddress');
const { loadConnectionConfig } = require('../services/kiotVietConnectionService');
const { buildPurchaseOrderPayload, createPurchaseOrder } = require('../kiotviet');
const { loadGeminiApiKey } = require('../services/geminiConnectionService');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
});
const SESSION_HOURS = 12;

const token = () => crypto.randomBytes(32).toString('base64url');
const safeText = (value, max = 255) => String(value || '').trim().slice(0, max);
const nonNegative = (value, field) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw Object.assign(new Error(`${field} không hợp lệ.`), { statusCode: 400 });
  return number;
};

async function ownedSession(pool, userId, sessionToken, lock = false) {
  const { rows } = await pool.query(
    `SELECT * FROM invoicesession WHERE session_token = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [sessionToken, userId],
  );
  return rows[0] || null;
}

async function publicSession(pool, sessionToken) {
  const { rows } = await pool.query(
    `SELECT * FROM invoicesession WHERE session_token = $1 AND expires_at > NOW()`,
    [sessionToken],
  );
  return rows[0] || null;
}

async function addImages(pool, session, files) {
  if (!files?.length) throw Object.assign(new Error('Hãy chọn ít nhất một ảnh.'), { statusCode: 400 });
  if (!['WAITING_IMAGES', 'UPLOADING', 'READY_TO_PROCESS', 'FAILED'].includes(session.status)) {
    throw Object.assign(new Error('Phiên này không còn nhận thêm ảnh.'), { statusCode: 409 });
  }
  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM invoicesessionimage WHERE invoice_session_id = $1', [session.invoice_session_id]);
  if (countResult.rows[0].count + files.length > 12) throw Object.assign(new Error('Mỗi hóa đơn hỗ trợ tối đa 12 ảnh.'), { statusCode: 400 });
  const saved = [];
    const client = await pool.connect();
  try {
    for (const file of files) saved.push({ ...(await saveTemporaryImage(file)), originalName: safeText(file.originalname) });
    await client.query('BEGIN');
    await client.query('SELECT invoice_session_id FROM invoicesession WHERE invoice_session_id = $1 FOR UPDATE', [session.invoice_session_id]);
    const maxPage = await client.query('SELECT COALESCE(MAX(page_number), 0)::int AS page FROM invoicesessionimage WHERE invoice_session_id = $1', [session.invoice_session_id]);
    for (let index = 0; index < saved.length; index += 1) {
      const image = saved[index];
      await client.query(
        `INSERT INTO invoicesessionimage (invoice_session_id, image_path, original_name, mime_type, file_size, page_number)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [session.invoice_session_id, image.imagePath, image.originalName, image.mimeType, image.fileSize, maxPage.rows[0].page + index + 1],
      );
    }
    await client.query("UPDATE invoicesession SET status = 'READY_TO_PROCESS', error_message = NULL, updated_at = NOW() WHERE invoice_session_id = $1", [session.invoice_session_id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    await removeTemporaryImages(saved.map((image) => image.imagePath));
    throw error;
  } finally { client.release(); }
  return saved.length;
}

async function processSession(pool, session) {
  try {
    const { rows } = await pool.query(
      'SELECT image_path, mime_type FROM invoicesessionimage WHERE invoice_session_id = $1 ORDER BY page_number',
      [session.invoice_session_id],
    );
    const files = await Promise.all(rows.map(async (image) => ({ mimetype: image.mime_type, buffer: await fs.readFile(image.image_path) })));
    const buyerResult = await pool.query('SELECT store_name, tax_code, address, phone, email FROM users WHERE user_id=$1', [session.user_id]);
    const gemini = await extractInvoiceFromImages(files, { apiKey: await loadGeminiApiKey(pool, session.user_id), buyer: buyerResult.rows[0] || {} });
    const corresponding = await mapExtractedInvoice(pool, gemini, session.user_id);
    await pool.query(
      "UPDATE invoicesession SET status = 'READY_FOR_REVIEW', ocr_result = $1, error_message = NULL, updated_at = NOW() WHERE invoice_session_id = $2 AND status = 'PROCESSING'",
      [JSON.stringify({ gemini, corresponding }), session.invoice_session_id],
    );
  } catch (error) {
    console.error('Invoice session processing failed:', error.message);
    await pool.query(
      "UPDATE invoicesession SET status = 'FAILED', error_message = $1, updated_at = NOW() WHERE invoice_session_id = $2",
      [safeText(error.message || 'Không thể xử lý hóa đơn.', 1000), session.invoice_session_id],
    ).catch(() => {});
  }
}

module.exports = function invoiceSessionRoutes(pool) {
  router.post('/api/invoice-sessions', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `INSERT INTO invoicesession (user_id, session_token, expires_at)
         VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)
         RETURNING session_token, status, expires_at`,
        [currentUserId(req), token(), String(SESSION_HOURS)],
      );
      res.status(201).json(rows[0]);
    } catch (error) { next(error); }
  });

  router.get('/api/invoice-sessions/:token/status', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedSession(pool, currentUserId(req), req.params.token);
      if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên hóa đơn.' });
      const count = await pool.query('SELECT COUNT(*)::int AS count FROM invoicesessionimage WHERE invoice_session_id = $1', [session.invoice_session_id]);
      res.json({ status: session.status, imageCount: count.rows[0].count, error: session.error_message, expiresAt: session.expires_at });
    } catch (error) { next(error); }
  });

  router.get('/api/invoice-sessions/:token', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedSession(pool, currentUserId(req), req.params.token);
      if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên hóa đơn.' });
      const { rows } = await pool.query('SELECT invoice_session_image_id, page_number FROM invoicesessionimage WHERE invoice_session_id = $1 ORDER BY page_number', [session.invoice_session_id]);
      res.json({ status: session.status, extraction: session.ocr_result, error: session.error_message, images: rows.map((image) => ({ pageNumber: image.page_number, url: `/api/invoice-sessions/${session.session_token}/images/${image.invoice_session_image_id}` })) });
    } catch (error) { next(error); }
  });

  router.delete('/api/invoice-sessions/:token', requireAuth, async (req, res, next) => {
    const client = await pool.connect();
    let imagePaths = [];
    try {
      await client.query('BEGIN');
      const session = await client.query('SELECT invoice_session_id,status FROM invoicesession WHERE session_token=$1 AND user_id=$2 FOR UPDATE', [req.params.token, currentUserId(req)]);
      if (!session.rowCount) throw Object.assign(new Error('Không tìm thấy phiên hóa đơn.'), { statusCode: 404 });
      if (session.rows[0].status === 'CONFIRMED') throw Object.assign(new Error('Không thể hủy phiên đã hoàn thành.'), { statusCode: 409 });
      const images = await client.query('SELECT image_path FROM invoicesessionimage WHERE invoice_session_id=$1', [session.rows[0].invoice_session_id]);
      imagePaths = images.rows.map((row) => row.image_path);
      await client.query('DELETE FROM invoicesessionimage WHERE invoice_session_id=$1', [session.rows[0].invoice_session_id]);
      await client.query('DELETE FROM invoicesession WHERE invoice_session_id=$1', [session.rows[0].invoice_session_id]);
      await client.query('COMMIT');
      await removeTemporaryImages(imagePaths); res.status(204).end();
    } catch (error) { await client.query('ROLLBACK'); next(error); }
    finally { client.release(); }
  });

  router.get('/api/invoice-sessions/:token/images/:imageId', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT isi.image_path, isi.mime_type FROM invoicesessionimage isi
         JOIN invoicesession ins ON ins.invoice_session_id = isi.invoice_session_id
         WHERE ins.session_token = $1 AND ins.user_id = $2 AND isi.invoice_session_image_id = $3`,
        [req.params.token, currentUserId(req), req.params.imageId],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy ảnh.' });
      res.type(rows[0].mime_type).sendFile(rows[0].image_path);
    } catch (error) { next(error); }
  });

  router.post('/api/invoice-sessions/:token/images', requireAuth, upload.array('invoiceImages', 12), async (req, res, next) => {
    try {
      const session = await ownedSession(pool, currentUserId(req), req.params.token);
      if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên hóa đơn.' });
      const added = await addImages(pool, session, req.files);
      res.status(201).json({ added });
    } catch (error) { next(error); }
  });

  router.post('/api/public/invoice-sessions/:token/images', upload.array('invoiceImages', 12), async (req, res, next) => {
    try {
      const session = await publicSession(pool, req.params.token);
      if (!session) return res.status(404).json({ error: 'Phiên upload không tồn tại hoặc đã hết hạn.' });
      const added = await addImages(pool, session, req.files);
      res.status(201).json({ added });
    } catch (error) { next(error); }
  });

  router.post('/api/invoice-sessions/:token/process', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedSession(pool, currentUserId(req), req.params.token);
      if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên hóa đơn.' });
      const imageCount = await pool.query('SELECT COUNT(*)::int AS count FROM invoicesessionimage WHERE invoice_session_id = $1', [session.invoice_session_id]);
      if (!imageCount.rows[0].count) return res.status(400).json({ error: 'Phiên chưa có ảnh.' });
      if (!['READY_TO_PROCESS', 'FAILED'].includes(session.status)) return res.status(409).json({ error: 'Phiên đang xử lý hoặc đã hoàn tất.' });
      const updated = await pool.query(
        "UPDATE invoicesession SET status = 'PROCESSING', error_message = NULL, updated_at = NOW() WHERE invoice_session_id = $1 AND status IN ('READY_TO_PROCESS', 'FAILED') RETURNING *",
        [session.invoice_session_id],
      );
      if (!updated.rowCount) return res.status(409).json({ error: 'Phiên đã thay đổi trạng thái.' });
      setImmediate(() => processSession(pool, updated.rows[0]));
      res.status(202).json({ status: 'PROCESSING' });
    } catch (error) { next(error); }
  });

  router.get('/api/invoice-sessions/:token/qr', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedSession(pool, currentUserId(req), req.params.token);
      if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên hóa đơn.' });
      const baseUrl = getMobileBaseUrl();
      const url = `${baseUrl}/invoice-session/${session.session_token}/upload`;
      const png = await QRCode.toBuffer(url, { width: 280, margin: 1 });
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Upload-URL': encodeURIComponent(url) }).send(png);
    } catch (error) { next(error); }
  });

  router.post('/api/invoice-sessions/:token/confirm', requireAuth, async (req, res, next) => {
    const client = await pool.connect();
    let imagePaths = [];
    try {
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      if (!items.length) throw Object.assign(new Error('Hóa đơn cần ít nhất một dòng hàng.'), { statusCode: 400 });
      const normalized = items.map((item, index) => ({
        productId: Number(item.productId),
        externalName: safeText(item.externalName),
        quantity: nonNegative(item.quantity, `Số lượng dòng ${index + 1}`),
        unit: safeText(item.unit, 100) || null,
        unitPrice: nonNegative(item.unitPrice, `Đơn giá dòng ${index + 1}`),
      }));
      if (normalized.some((item) => !Number.isInteger(item.productId) || item.productId <= 0)) throw Object.assign(new Error('Mỗi dòng phải chọn một hàng hóa tương ứng.'), { statusCode: 400 });
      const discount = nonNegative(req.body.discountAmount || 0, 'Chiết khấu');

      await client.query('BEGIN');
      const sessionResult = await client.query('SELECT * FROM invoicesession WHERE session_token = $1 AND user_id = $2 FOR UPDATE', [req.params.token, currentUserId(req)]);
      const session = sessionResult.rows[0];
      if (!session) throw Object.assign(new Error('Không tìm thấy phiên hóa đơn.'), { statusCode: 404 });
      if (session.status !== 'READY_FOR_REVIEW') throw Object.assign(new Error('Phiên chưa sẵn sàng để xác nhận.'), { statusCode: 409 });
      const productIds = [...new Set(normalized.map((item) => item.productId))];
      const productCheck = await client.query('SELECT product_id, product_code FROM product WHERE user_id = $1 AND product_id = ANY($2::int[])', [currentUserId(req), productIds]);
      if (productCheck.rowCount !== productIds.length) throw Object.assign(new Error('Có hàng hóa không thuộc account hiện tại.'), { statusCode: 403 });
      const productsById = new Map(productCheck.rows.map((product) => [product.product_id, product]));
      if (productCheck.rows.some((product) => !product.product_code)) {
        throw Object.assign(new Error('Có hàng hóa chưa có mã KiotViet nên chưa thể tạo phiếu nhập.'), { statusCode: 400 });
      }

      let supplierId = Number(req.body.supplierId);
      let supplierRecord;
      if (Number.isInteger(supplierId) && supplierId > 0) {
        const supplier = await client.query('SELECT supplier_id, supplier_name, phone_number, address FROM supplier WHERE supplier_id = $1 AND user_id = $2', [supplierId, currentUserId(req)]);
        if (!supplier.rowCount) throw Object.assign(new Error('Nhà cung cấp không thuộc account hiện tại.'), { statusCode: 403 });
        supplierRecord = supplier.rows[0];
      } else {
        const supplierName = safeText(req.body.supplierName);
        if (!supplierName) throw Object.assign(new Error('Hãy nhập hoặc chọn nhà cung cấp.'), { statusCode: 400 });
        const existing = await client.query('SELECT supplier_id FROM supplier WHERE user_id = $1 AND LOWER(supplier_name) = LOWER($2) LIMIT 1', [currentUserId(req), supplierName]);
        if (existing.rowCount) {
          supplierId = existing.rows[0].supplier_id;
          supplierRecord = (await client.query('SELECT supplier_id, supplier_name, phone_number, address FROM supplier WHERE supplier_id = $1', [supplierId])).rows[0];
        }
        else {
          const inserted = await client.query('INSERT INTO supplier (user_id, supplier_name, phone_number, address) VALUES ($1, $2, $3, $4) RETURNING supplier_id, supplier_name, phone_number, address', [currentUserId(req), supplierName, safeText(req.body.supplierPhone) || null, safeText(req.body.supplierAddress, 1000) || null]);
          supplierId = inserted.rows[0].supplier_id;
          supplierRecord = inserted.rows[0];
        }
      }

      const subtotal = normalized.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
      if (discount > subtotal) throw Object.assign(new Error('Chiết khấu không được lớn hơn tổng tiền hàng.'), { statusCode: 400 });
      const invoiceDate = req.body.invoiceDate ? new Date(req.body.invoiceDate) : null;
      if (invoiceDate && Number.isNaN(invoiceDate.getTime())) throw Object.assign(new Error('Ngày hóa đơn không hợp lệ.'), { statusCode: 400 });
      const branch = (await client.query('SELECT kiotviet_id FROM kiotvietbranch WHERE user_id = $1 ORDER BY branch_id LIMIT 1', [currentUserId(req)])).rows[0];
      const purchasePayload = branch ? buildPurchaseOrderPayload({
        branchId: Number(branch.kiotviet_id),
        supplier: {
          name: supplierRecord.supplier_name,
          phone: supplierRecord.phone_number,
          address: supplierRecord.address,
        },
        purchaseDate: invoiceDate || new Date(),
        discount,
        total: subtotal - discount,
        invoiceNumber: safeText(req.body.invoiceNumber) || null,
        items: normalized.map((item) => ({
          productCode: productsById.get(item.productId).product_code,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      }) : null;
      let kiotVietOrder = null;
      let kiotVietSyncError = null;
      try {
        if (!branch) throw new Error('Chưa có chi nhánh KiotViet.');
        const connectionConfig = await loadConnectionConfig(pool, currentUserId(req));
        kiotVietOrder = await createPurchaseOrder(connectionConfig, purchasePayload);
      }
      catch (error) { kiotVietSyncError = error; }
      const invoice = await client.query(
        `INSERT INTO purchaseinvoice
          (user_id, supplier_id, invoice_date, invoice_number, total_amount, discount_amount, status,
           kiotviet_purchase_order_id, kiotviet_purchase_order_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING invoice_id`,
        [currentUserId(req), supplierId, invoiceDate, safeText(req.body.invoiceNumber) || null, subtotal - discount, discount,
          kiotVietOrder ? 'SYNCED' : 'PENDING_SYNC', kiotVietOrder?.id || null, kiotVietOrder?.code || null],
      );
      for (const item of normalized) {
        await client.query(
          `INSERT INTO purchaseinvoiceitem (invoice_id, product_id, quantity, unit, unit_price, total_price)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [invoice.rows[0].invoice_id, item.productId, item.quantity, item.unit, item.unitPrice, item.quantity * item.unitPrice],
        );
        if (item.externalName) {
          const mapping = await client.query('SELECT mapping_id FROM productmapping WHERE supplier_id = $1 AND LOWER(provider_product_name) = LOWER($2) LIMIT 1', [supplierId, item.externalName]);
          if (mapping.rowCount) await client.query('UPDATE productmapping SET local_product_id = $1, local_unit = $2 WHERE mapping_id = $3', [item.productId, item.unit, mapping.rows[0].mapping_id]);
          else await client.query('INSERT INTO productmapping (supplier_id, local_product_id, provider_product_name, local_unit) VALUES ($1, $2, $3, $4)', [supplierId, item.productId, item.externalName, item.unit]);
        }
      }
      const imageResult = await client.query('SELECT image_path FROM invoicesessionimage WHERE invoice_session_id = $1', [session.invoice_session_id]);
      imagePaths = imageResult.rows.map((row) => row.image_path);
      await client.query("UPDATE invoicesession SET status = 'CONFIRMED', updated_at = NOW() WHERE invoice_session_id = $1", [session.invoice_session_id]);
      await client.query('DELETE FROM invoicesessionimage WHERE invoice_session_id = $1', [session.invoice_session_id]);
      await client.query('COMMIT');
      await removeTemporaryImages(imagePaths);
      res.status(201).json({
        invoiceId: invoice.rows[0].invoice_id,
        status: kiotVietOrder ? 'SYNCED' : 'PENDING_SYNC',
        kiotVietPurchaseOrderId: kiotVietOrder?.id || null,
        kiotVietPurchaseOrderCode: kiotVietOrder?.code || null,
        warning: kiotVietSyncError ? 'Hóa đơn đã lưu nhưng chưa đồng bộ được KiotViet. Bạn có thể đồng bộ lại từ danh sách Nhập hàng.' : null,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally { client.release(); }
  });

  return router;
};

module.exports.uploadMiddleware = upload;
