const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { saveTemporaryImage, removeTemporaryImages } = require('../services/imageFileService');
const { processInvoiceSession } = require('../services/invoiceSessionProcessingService');
const { requireAuth, currentUserId } = require('../middleware/auth');
const { getMobileBaseUrl } = require('../services/lanAddress');
const { loadConnectionConfig } = require('../services/kiotVietConnectionService');
const { calculateInvoiceTax, pricesAfterTax, paidAmountForInvoice } = require('../services/invoiceTaxService');
const { mapExtractedInvoice } = require('../services/invoiceMappingService');
const { buildPurchaseOrderPayload, createPurchaseOrder } = require('../kiotviet');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
});
const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, callback) => callback(null, /^image\/(jpeg|png|webp)$/i.test(file.mimetype)),
});
const SESSION_HOURS = 12;

const token = () => crypto.randomBytes(32).toString('base64url');
const safeText = (value, max = 255) => String(value || '').trim().slice(0, max);
const normalizedText = (value) => safeText(value).toLocaleLowerCase('vi-VN').replace(/\s+/g, ' ');
const closeNumber = (left, right) => Math.abs(Number(left) - Number(right)) <= Math.max(0.000001, Math.abs(Number(right)) * 0.000001);
const conversionKey = (productId, externalName, externalUnit) => `${productId}|${normalizedText(externalName)}|${normalizedText(externalUnit)}`;
const nonNegative = (value, field) => {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim()) || !['string', 'number'].includes(typeof value)) throw Object.assign(new Error(`${field} chưa được điền.`), { statusCode: 400 });
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
    await processInvoiceSession(pool, session);
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

  router.post('/api/invoice-sessions/bulk', requireAuth, bulkUpload.array('invoiceImages', 20), async (req, res, next) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Hãy chọn ít nhất một ảnh hóa đơn.' });
    const saved = [];
    const client = await pool.connect();
    try {
      for (const file of files) saved.push({ ...(await saveTemporaryImage(file)), originalName: safeText(file.originalname) });
      const batchToken = token();
      const promptVersion = ['compact', 'detailed'].includes(String(process.env.GEMINI_PROMPT_VERSION || '').toLowerCase())
        ? String(process.env.GEMINI_PROMPT_VERSION).toLowerCase() : 'compact';
      const sessions = [];
      await client.query('BEGIN');
      for (const image of saved) {
        const session = (await client.query(`INSERT INTO invoicesession
          (user_id,session_token,status,source_mode,batch_token,prompt_version,next_attempt_at,expires_at)
          VALUES($1,$2,'QUEUED','BATCH',$3,$4,NOW(),NOW()+INTERVAL '7 days')
          RETURNING invoice_session_id,session_token,status`,
        [currentUserId(req), token(), batchToken, promptVersion])).rows[0];
        await client.query(`INSERT INTO invoicesessionimage
          (invoice_session_id,image_path,original_name,mime_type,file_size,page_number)
          VALUES($1,$2,$3,$4,$5,1)`,
        [session.invoice_session_id, image.imagePath, image.originalName, image.mimeType, image.fileSize]);
        sessions.push({ sessionToken: session.session_token, status: session.status, fileName: image.originalName });
      }
      await client.query('COMMIT');
      res.status(202).json({ batchToken, count: sessions.length, sessions });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await removeTemporaryImages(saved.map((image) => image.imagePath));
      next(error);
    } finally { client.release(); }
  });

  router.get('/api/invoice-sessions/:token/status', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedSession(pool, currentUserId(req), req.params.token);
      if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên hóa đơn.' });
      const count = await pool.query('SELECT COUNT(*)::int AS count FROM invoicesessionimage WHERE invoice_session_id = $1', [session.invoice_session_id]);
      res.json({ status: session.status, imageCount: count.rows[0].count, error: session.error_message, attempts: session.queue_attempts, nextAttemptAt: session.next_attempt_at, expiresAt: session.expires_at });
    } catch (error) { next(error); }
  });

  router.get('/api/invoice-sessions/:token', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedSession(pool, currentUserId(req), req.params.token);
      if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên hóa đơn.' });
      const { rows } = await pool.query('SELECT invoice_session_image_id, page_number FROM invoicesessionimage WHERE invoice_session_id = $1 ORDER BY page_number', [session.invoice_session_id]);
      let extraction = session.ocr_result;
      if (extraction?.gemini && ['READY_FOR_REVIEW', 'INCOMPLETE'].includes(session.status)) {
        extraction = {
          ...extraction,
          // Always use the latest confirmed mappings when opening a correction page.
          corresponding: await mapExtractedInvoice(pool, extraction.gemini, currentUserId(req)),
        };
      }
      res.json({ status: session.status, extraction, error: session.error_message, images: rows.map((image) => ({ imageId: image.invoice_session_image_id, pageNumber: image.page_number, url: `/api/invoice-sessions/${session.session_token}/images/${image.invoice_session_image_id}` })) });
    } catch (error) { next(error); }
  });

  router.get('/api/invoice-sessions/:token/mapping', requireAuth, async (req, res, next) => {
    try {
      const session = await ownedSession(pool, currentUserId(req), req.params.token);
      if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên hóa đơn.' });
      if (!session.ocr_result?.gemini || !['READY_FOR_REVIEW', 'INCOMPLETE'].includes(session.status)) {
        return res.status(409).json({ error: 'Phiên chưa sẵn sàng để đối chiếu.' });
      }
      const supplierId = Number(req.query.supplierId);
      if (!Number.isInteger(supplierId) || supplierId <= 0) return res.status(400).json({ error: 'Nhà cung cấp không hợp lệ.' });
      const supplier = await pool.query('SELECT supplier_id FROM supplier WHERE supplier_id=$1 AND user_id=$2', [supplierId, currentUserId(req)]);
      if (!supplier.rowCount) return res.status(403).json({ error: 'Nhà cung cấp không thuộc account hiện tại.' });
      res.json({ corresponding: await mapExtractedInvoice(pool, session.ocr_result.gemini, currentUserId(req), { supplierId }) });
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

  router.delete('/api/invoice-sessions/:token/images/:imageId', requireAuth, async (req, res, next) => {
    const client = await pool.connect();
    let imagePath = null;
    try {
      await client.query('BEGIN');
      const sessionResult = await client.query('SELECT * FROM invoicesession WHERE session_token=$1 AND user_id=$2 FOR UPDATE', [req.params.token, currentUserId(req)]);
      const session = sessionResult.rows[0];
      if (!session) throw Object.assign(new Error('Không tìm thấy phiên hóa đơn.'), { statusCode: 404 });
      if (!['WAITING_IMAGES', 'UPLOADING', 'READY_TO_PROCESS', 'FAILED'].includes(session.status)) throw Object.assign(new Error('Chỉ có thể chỉnh ảnh trước khi gửi Gemini.'), { statusCode: 409 });
      const imageResult = await client.query('DELETE FROM invoicesessionimage WHERE invoice_session_id=$1 AND invoice_session_image_id=$2 RETURNING image_path', [session.invoice_session_id, req.params.imageId]);
      if (!imageResult.rowCount) throw Object.assign(new Error('Không tìm thấy ảnh.'), { statusCode: 404 });
      imagePath = imageResult.rows[0].image_path;
      const count = await client.query('SELECT COUNT(*)::int AS count FROM invoicesessionimage WHERE invoice_session_id=$1', [session.invoice_session_id]);
      await client.query("UPDATE invoicesession SET status=$1, updated_at=NOW() WHERE invoice_session_id=$2", [count.rows[0].count ? 'READY_TO_PROCESS' : 'WAITING_IMAGES', session.invoice_session_id]);
      await client.query('COMMIT');
      await removeTemporaryImages([imagePath]);
      res.status(204).end();
    } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
  });

  router.put('/api/invoice-sessions/:token/images/order', requireAuth, async (req, res, next) => {
    const client = await pool.connect();
    try {
      const imageIds = Array.isArray(req.body?.imageIds) ? req.body.imageIds.map(Number) : [];
      await client.query('BEGIN');
      const sessionResult = await client.query('SELECT * FROM invoicesession WHERE session_token=$1 AND user_id=$2 FOR UPDATE', [req.params.token, currentUserId(req)]);
      const session = sessionResult.rows[0];
      if (!session) throw Object.assign(new Error('Không tìm thấy phiên hóa đơn.'), { statusCode: 404 });
      if (!['WAITING_IMAGES', 'UPLOADING', 'READY_TO_PROCESS', 'FAILED'].includes(session.status)) throw Object.assign(new Error('Chỉ có thể sắp xếp ảnh trước khi gửi Gemini.'), { statusCode: 409 });
      const existing = await client.query('SELECT invoice_session_image_id FROM invoicesessionimage WHERE invoice_session_id=$1 ORDER BY page_number', [session.invoice_session_id]);
      const existingIds = existing.rows.map((row) => row.invoice_session_image_id);
      if (imageIds.length !== existingIds.length || new Set(imageIds).size !== imageIds.length || imageIds.some((id) => !existingIds.includes(id))) throw Object.assign(new Error('Danh sách thứ tự ảnh không hợp lệ.'), { statusCode: 400 });
      // Avoid the unique (session, page_number) constraint while swapping rows.
      await client.query('UPDATE invoicesessionimage SET page_number=page_number+1000 WHERE invoice_session_id=$1', [session.invoice_session_id]);
      for (let index = 0; index < imageIds.length; index += 1) await client.query('UPDATE invoicesessionimage SET page_number=$1 WHERE invoice_session_id=$2 AND invoice_session_image_id=$3', [index + 1, session.invoice_session_id, imageIds[index]]);
      await client.query('COMMIT'); res.json({ updated: true });
    } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
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
      if (session.source_mode === 'BATCH' && ['FAILED', 'RETRY_WAIT'].includes(session.status)) {
        await pool.query(`UPDATE invoicesession SET status='QUEUED', queue_attempts=0, route_index=0,
          prompt_version=$1, next_attempt_at=NOW(), error_message=NULL, processing_started_at=NULL, updated_at=NOW()
          WHERE invoice_session_id=$2`,
        [String(process.env.GEMINI_PROMPT_VERSION || 'compact').toLowerCase() === 'detailed' ? 'detailed' : 'compact', session.invoice_session_id]);
        return res.status(202).json({ status: 'QUEUED' });
      }
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
        externalUnit: safeText(item.externalUnit, 100) || null,
        externalQuantity: item.externalQuantity === null || item.externalQuantity === undefined || String(item.externalQuantity).trim() === '' ? null : nonNegative(item.externalQuantity, `Số lượng đọc được dòng ${index + 1}`),
        quantity: nonNegative(item.quantity, `Số lượng dòng ${index + 1}`),
        unit: safeText(item.unit, 100) || null,
        unitPrice: nonNegative(item.unitPrice, `Đơn giá dòng ${index + 1}`),
      }));
      if (normalized.some((item) => item.quantity <= 0)) throw Object.assign(new Error('Số lượng mỗi dòng phải lớn hơn 0.'), { statusCode: 400 });
      if (normalized.some((item) => !Number.isInteger(item.productId) || item.productId <= 0)) throw Object.assign(new Error('Mỗi dòng phải chọn một hàng hóa tương ứng.'), { statusCode: 400 });
      const discount = nonNegative(req.body.discountAmount || 0, 'Chiết khấu');

      await client.query('BEGIN');
      const sessionResult = await client.query('SELECT * FROM invoicesession WHERE session_token = $1 AND user_id = $2 FOR UPDATE', [req.params.token, currentUserId(req)]);
      const session = sessionResult.rows[0];
      if (!session) throw Object.assign(new Error('Không tìm thấy phiên hóa đơn.'), { statusCode: 404 });
      if (session.status !== 'READY_FOR_REVIEW') throw Object.assign(new Error('Phiên chưa sẵn sàng để xác nhận.'), { statusCode: 409 });
      const requestedConversions = Array.isArray(req.body.unitConversions) ? req.body.unitConversions : [];
      if (requestedConversions.length > normalized.length) throw Object.assign(new Error('Danh sách quy đổi đơn vị không hợp lệ.'), { statusCode: 400 });
      const extractedItems = Array.isArray(session.ocr_result?.gemini?.items) ? session.ocr_result.gemini.items : [];
      const conversionsByKey = new Map();
      for (const requested of requestedConversions) {
        const productId = Number(requested.productId);
        const externalName = safeText(requested.externalName);
        const externalUnit = safeText(requested.externalUnit, 100);
        const localUnit = safeText(requested.localUnit, 100);
        const rate = Number(requested.conversionRate);
        if (!Number.isInteger(productId) || productId <= 0 || !externalName || !externalUnit || !localUnit || !Number.isFinite(rate) || rate <= 0 || rate > 1000000) {
          throw Object.assign(new Error('Quy đổi đơn vị không hợp lệ.'), { statusCode: 400 });
        }
        const line = normalized.find((item) => item.productId === productId
          && normalizedText(item.externalName) === normalizedText(externalName)
          && normalizedText(item.externalUnit) === normalizedText(externalUnit)
          && normalizedText(item.unit) === normalizedText(localUnit)
          && item.externalQuantity > 0);
        const extracted = extractedItems.find((item) => normalizedText(item.name) === normalizedText(externalName)
          && normalizedText(item.unit) === normalizedText(externalUnit)
          && Number(item.quantity) > 0 && closeNumber(item.quantity, line?.externalQuantity));
        if (!line || !extracted || normalizedText(externalUnit) === normalizedText(localUnit)
            || closeNumber(line.quantity, line.externalQuantity) || !closeNumber(rate, line.quantity / line.externalQuantity)) {
          throw Object.assign(new Error('Quy đổi không khớp dữ liệu hóa đơn đã chỉnh sửa.'), { statusCode: 400 });
        }
        const key = conversionKey(productId, externalName, externalUnit);
        if (conversionsByKey.has(key) && !closeNumber(conversionsByKey.get(key).rate, rate)) {
          throw Object.assign(new Error('Một hàng hóa có nhiều hệ số quy đổi xung đột.'), { statusCode: 400 });
        }
        conversionsByKey.set(key, { rate, localUnit });
      }
      const productIds = [...new Set(normalized.map((item) => item.productId))];
      const productCheck = await client.query('SELECT product_id, product_code FROM product WHERE user_id = $1 AND product_id = ANY($2::int[])', [currentUserId(req), productIds]);
      if (productCheck.rowCount !== productIds.length) throw Object.assign(new Error('Có hàng hóa không thuộc account hiện tại.'), { statusCode: 403 });
      const productsById = new Map(productCheck.rows.map((product) => [product.product_id, product]));
      if (productCheck.rows.some((product) => !product.product_code)) {
        throw Object.assign(new Error('Có hàng hóa chưa có mã KiotViet nên chưa thể tạo phiếu nhập.'), { statusCode: 400 });
      }

      const supplierId = Number(req.body.supplierId);
      if (!Number.isInteger(supplierId) || supplierId <= 0) throw Object.assign(new Error('Hãy chọn nhà cung cấp từ danh mục KiotViet đã đồng bộ.'), { statusCode: 400 });
      const supplier = await client.query('SELECT supplier_id, supplier_name, phone_number, address FROM supplier WHERE supplier_id = $1 AND user_id = $2', [supplierId, currentUserId(req)]);
      if (!supplier.rowCount) throw Object.assign(new Error('Nhà cung cấp không thuộc account hiện tại.'), { statusCode: 403 });
      const supplierRecord = supplier.rows[0];

      const subtotal = normalized.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
      if (discount > subtotal) throw Object.assign(new Error('Chiết khấu không được lớn hơn tổng tiền hàng.'), { statusCode: 400 });
      const tax = calculateInvoiceTax({ subtotal, discount, taxMode: req.body.taxMode, taxValue: req.body.taxValue });
      const paidAmount = paidAmountForInvoice(req.body.paidAmount, tax.totalAfterTax);
      const taxedItems = pricesAfterTax(normalized, tax.taxAmount);
      const invoiceDate = req.body.invoiceDate ? new Date(req.body.invoiceDate) : null;
      if (invoiceDate && Number.isNaN(invoiceDate.getTime())) throw Object.assign(new Error('Ngày hóa đơn không hợp lệ.'), { statusCode: 400 });
      const invoiceNumber = safeText(req.body.invoiceNumber) || null;
      if (invoiceNumber) {
        const duplicate = await client.query(`
          SELECT invoice_id, kiotviet_purchase_order_code
          FROM purchaseinvoice
          WHERE user_id=$1 AND supplier_id=$2 AND status='SYNCED'
            AND LOWER(TRIM(invoice_number))=LOWER(TRIM($3))
          ORDER BY invoice_id DESC LIMIT 1
        `, [currentUserId(req), supplierId, invoiceNumber]);
        if (duplicate.rowCount) {
          const existing = duplicate.rows[0];
          throw Object.assign(new Error(`Số hóa đơn ${invoiceNumber} đã được đồng bộ ở hóa đơn #${existing.invoice_id}${existing.kiotviet_purchase_order_code ? ` (phiếu KiotViet ${existing.kiotviet_purchase_order_code})` : ''}. Hãy mở hóa đơn đó để sửa hoặc đổi số nếu đây là chứng từ khác.`), { statusCode: 409 });
        }
      }
      const branch = (await client.query('SELECT kiotviet_id FROM kiotvietbranch WHERE user_id = $1 ORDER BY branch_id LIMIT 1', [currentUserId(req)])).rows[0];
      const purchasePayload = branch ? buildPurchaseOrderPayload({
        branchId: Number(branch.kiotviet_id),
        supplier: {
          name: supplierRecord.supplier_name,
          phone: supplierRecord.phone_number,
          address: supplierRecord.address,
        },
        discount,
        total: tax.totalAfterTax,
        paidAmount,
        invoiceNumber,
        items: taxedItems.map((item) => ({
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
          (user_id, supplier_id, invoice_date, invoice_number, total_amount, discount_amount,
           tax_input_mode, tax_rate, tax_amount, paid_amount, status, kiotviet_purchase_order_id, kiotviet_purchase_order_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING invoice_id`,
        [currentUserId(req), supplierId, invoiceDate, invoiceNumber, tax.totalAfterTax, discount,
          tax.taxMode, tax.taxRate, tax.taxAmount, paidAmount, kiotVietOrder ? 'SYNCED' : 'PENDING_SYNC', kiotVietOrder?.id || null, kiotVietOrder?.code || null],
      );
      for (const item of normalized) {
        await client.query(
          `INSERT INTO purchaseinvoiceitem (invoice_id, product_id, quantity, unit, unit_price, total_price)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [invoice.rows[0].invoice_id, item.productId, item.quantity, item.unit, item.unitPrice, item.quantity * item.unitPrice],
        );
        if (item.externalName) {
          const selectedConversion = conversionsByKey.get(conversionKey(item.productId, item.externalName, item.externalUnit));
          const mapping = await client.query("SELECT mapping_id,local_product_id,conversion_rate_to_local FROM productmapping WHERE supplier_id = $1 AND LOWER(provider_product_name) = LOWER($2) AND LOWER(COALESCE(provider_unit,'')) = LOWER(COALESCE($3,'')) LIMIT 1", [supplierId, item.externalName, item.externalUnit]);
          if (mapping.rowCount) {
            const sameProduct = Number(mapping.rows[0].local_product_id) === item.productId;
            const rate = selectedConversion?.rate ?? (sameProduct ? mapping.rows[0].conversion_rate_to_local : null);
            await client.query('UPDATE productmapping SET local_product_id=$1,provider_unit=$2,local_unit=$3,conversion_rate_to_local=$4 WHERE mapping_id=$5', [item.productId, item.externalUnit, item.unit, rate, mapping.rows[0].mapping_id]);
          } else {
            await client.query('INSERT INTO productmapping (supplier_id,local_product_id,provider_product_name,provider_unit,local_unit,conversion_rate_to_local) VALUES ($1,$2,$3,$4,$5,$6)', [supplierId, item.productId, item.externalName, item.externalUnit, item.unit, selectedConversion?.rate ?? null]);
          }
        }
      }
      const externalSupplierName = safeText(session.ocr_result?.gemini?.supplier?.name);
      if (externalSupplierName) {
        const supplierMapping = await client.query('SELECT supplier_mapping_id FROM suppliermapping WHERE local_supplier_id=$1 AND LOWER(provider_supplier_name)=LOWER($2) LIMIT 1', [supplierId, externalSupplierName]);
        if (!supplierMapping.rowCount) await client.query('INSERT INTO suppliermapping(local_supplier_id,provider_supplier_name) VALUES($1,$2)', [supplierId, externalSupplierName]);
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
