const fs = require('fs/promises');
const { extractInvoiceFromImagesDetailed } = require('./geminiInvoiceService');
const { loadGeminiConnection } = require('./geminiConnectionService');
const { mapExtractedInvoice } = require('./invoiceMappingService');
const { inspectInvoice, readingsAgree, normalizeInvoiceMoney } = require('./invoiceSanityService');

function shouldVerifyInspection(firstInspection, invoice) {
  const handwritten = ['HANDWRITTEN', 'MIXED'].includes(invoice?.document_type);
  return firstInspection.needsVerification && !handwritten && process.env.GEMINI_VERIFY_SUSPICIOUS !== 'false';
}

async function processInvoiceSession(pool, session, extractionOptions = {}) {
  const { rows } = await pool.query(
    'SELECT image_path, mime_type FROM invoicesessionimage WHERE invoice_session_id = $1 ORDER BY page_number',
    [session.invoice_session_id],
  );
  if (!rows.length) throw Object.assign(new Error('Phiên chưa có ảnh.'), { statusCode: 400 });
  const files = await Promise.all(rows.map(async (image) => ({ mimetype: image.mime_type, buffer: await fs.readFile(image.image_path) })));
  const buyer = (await pool.query('SELECT store_name, tax_code, address, phone, email FROM users WHERE user_id=$1', [session.user_id])).rows[0] || {};
  const connection = await loadGeminiConnection(pool, session.user_id);
  const details = await extractInvoiceFromImagesDetailed(files, {
    connection,
    buyer,
    ...extractionOptions,
  });
  const firstInspection = inspectInvoice(details.invoice);
  let reviewedInvoice = firstInspection.invoice;
  const sanity = {
    issues: firstInspection.issues,
    normalization_applied: !firstInspection.needsVerification,
    verification: firstInspection.needsVerification ? { status: 'NOT_RUN' } : { status: 'NOT_NEEDED' },
  };

  // Handwriting is returned for human review after one reading. Repeating a
  // difficult handwritten image adds latency without making it authoritative.
  const isHandwritten = ['HANDWRITTEN', 'MIXED'].includes(reviewedInvoice.document_type);
  if (shouldVerifyInspection(firstInspection, reviewedInvoice)) {
    try {
      const verificationDetails = await extractInvoiceFromImagesDetailed(files, {
        ...extractionOptions,
        connection,
        buyer,
        singleRoute: true,
        routeIndex: details.route_index,
        promptVersion: details.prompt_used,
      });
      const secondInspection = inspectInvoice(verificationDetails.invoice);
      if (readingsAgree(firstInspection.invoice, secondInspection.invoice)) {
        sanity.normalization_applied = true;
        sanity.verification = { status: 'CONSISTENT', model: verificationDetails.model_used };
      } else {
        reviewedInvoice = normalizeInvoiceMoney(details.invoice).invoice;
        sanity.verification = { status: 'DISAGREEMENT', model: verificationDetails.model_used };
        sanity.issues.push({
          code: 'SECOND_READING_DISAGREEMENT',
          severity: 'warning',
          message: 'Hai lượt đọc không thống nhất. Hệ thống giữ dữ liệu lượt đầu để người dùng kiểm tra, không tự sửa.',
        });
      }
    } catch (error) {
      reviewedInvoice = normalizeInvoiceMoney(details.invoice).invoice;
      sanity.verification = { status: 'FAILED' };
      sanity.issues.push({
        code: 'SECOND_READING_FAILED',
        severity: 'warning',
        message: 'Không thể hoàn tất lượt kiểm chứng. Hệ thống giữ dữ liệu lượt đầu để người dùng kiểm tra.',
      });
    }
  } else if (firstInspection.needsVerification) {
    reviewedInvoice = normalizeInvoiceMoney(details.invoice).invoice;
    if (isHandwritten) sanity.verification = { status: 'SKIPPED_HANDWRITING' };
  }

  // Batch sessions intentionally defer catalog lookup until the user opens the
  // correction page. Mappings confirmed on earlier invoices are then available
  // to later invoices in the same batch.
  const corresponding = session.source_mode === 'BATCH'
    ? null
    : await mapExtractedInvoice(pool, reviewedInvoice, session.user_id);
  const storedResult = { gemini: reviewedInvoice, raw_gemini: details.raw_json || details.invoice, sanity };
  if (corresponding) storedResult.corresponding = corresponding;
  const updated = await pool.query(
    `UPDATE invoicesession
     SET status='READY_FOR_REVIEW', ocr_result=$1, error_message=NULL,
         next_attempt_at=NULL, processing_started_at=NULL, updated_at=NOW()
     WHERE invoice_session_id=$2 AND status='PROCESSING'`,
    [JSON.stringify(storedResult), session.invoice_session_id],
  );
  return { updated: updated.rowCount === 1, details };
}

module.exports = { processInvoiceSession, shouldVerifyInspection };
