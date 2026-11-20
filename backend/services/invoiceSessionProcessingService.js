const fs = require('fs/promises');
const { extractInvoiceFromImagesDetailed } = require('./geminiInvoiceService');
const { loadGeminiConnection } = require('./geminiConnectionService');
const { mapExtractedInvoice } = require('./invoiceMappingService');

async function processInvoiceSession(pool, session, extractionOptions = {}) {
  const { rows } = await pool.query(
    'SELECT image_path, mime_type FROM invoicesessionimage WHERE invoice_session_id = $1 ORDER BY page_number',
    [session.invoice_session_id],
  );
  if (!rows.length) throw Object.assign(new Error('Phiên chưa có ảnh.'), { statusCode: 400 });
  const files = await Promise.all(rows.map(async (image) => ({ mimetype: image.mime_type, buffer: await fs.readFile(image.image_path) })));
  const buyer = (await pool.query('SELECT store_name, tax_code, address, phone, email FROM users WHERE user_id=$1', [session.user_id])).rows[0] || {};
  const details = await extractInvoiceFromImagesDetailed(files, {
    connection: await loadGeminiConnection(pool, session.user_id),
    buyer,
    ...extractionOptions,
  });
  const corresponding = await mapExtractedInvoice(pool, details.invoice, session.user_id);
  const updated = await pool.query(
    `UPDATE invoicesession
     SET status='READY_FOR_REVIEW', ocr_result=$1, error_message=NULL,
         next_attempt_at=NULL, processing_started_at=NULL, updated_at=NOW()
     WHERE invoice_session_id=$2 AND status='PROCESSING'`,
    [JSON.stringify({ gemini: details.invoice, corresponding }), session.invoice_session_id],
  );
  return { updated: updated.rowCount === 1, details };
}

module.exports = { processInvoiceSession };
