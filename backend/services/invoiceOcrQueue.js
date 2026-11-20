const { processInvoiceSession } = require('./invoiceSessionProcessingService');

const safeMessage = (value, max = 1000) => String(value || '').trim().slice(0, max);

function failureDetails(error) {
  const diagnostics = error?.diagnostics || {};
  const lastAttempt = diagnostics.attempts?.at(-1) || {};
  const status = Number(lastAttempt.http_status || error?.statusCode || error?.status) || null;
  const raw = `${error?.message || ''} ${lastAttempt.error || ''}`;
  const invalidOutput = Boolean(diagnostics.prompt_failures?.length) || /response rỗng|JSON không hợp lệ|không đúng schema/i.test(raw);
  const retryable = invalidOutput || [401, 402, 403, 404, 408, 429, 500, 502, 503, 504].includes(status)
    || /abort|timeout|timed out|fetch failed|model_not_found|no available channel|rate.limit/i.test(raw);
  let delaySeconds = 30;
  if (status === 429 || /rate.limit/i.test(raw)) delaySeconds = 90;
  else if (/model_not_found|no available channel/i.test(raw)) delaySeconds = 120;
  else if (status === 503) delaySeconds = 60;
  const publicMessage = status === 429 || /rate.limit/i.test(raw)
    ? 'Dịch vụ đang giới hạn tần suất. Hệ thống sẽ tự thử lại.'
    : status === 504 || /timeout|timed out|deadline/i.test(raw)
      ? 'Lần xử lý vừa rồi quá thời gian. Hệ thống sẽ tự thử lại.'
      : /model_not_found|no available channel/i.test(raw)
        ? 'Dịch vụ tạm thời chưa có kênh xử lý. Hệ thống sẽ tự thử lại.'
        : invalidOutput
          ? 'Kết quả trả về chưa đúng định dạng. Hệ thống sẽ thử lại.'
          : 'Chưa xử lý được ảnh. Hệ thống sẽ tự thử lại.';
  return { diagnostics, status, invalidOutput, retryable, delaySeconds, publicMessage };
}

function startInvoiceOcrQueue(pool) {
  const tickMs = Math.max(1000, Number(process.env.INVOICE_OCR_QUEUE_TICK_MS) || 3000);
  const maxAttempts = Math.max(1, Number(process.env.INVOICE_OCR_MAX_ATTEMPTS) || 8);
  let busy = false;
  let stopped = false;

  async function recover() {
    await pool.query(`UPDATE invoicesession
      SET status='RETRY_WAIT', next_attempt_at=NOW(), processing_started_at=NULL,
          error_message='Tiến trình xử lý đã khởi động lại. Hệ thống sẽ tiếp tục tự động.', updated_at=NOW()
      WHERE source_mode='BATCH' AND status='PROCESSING'`);
  }

  async function claim() {
    const { rows } = await pool.query(`
      WITH candidate AS (
        SELECT invoice_session_id FROM invoicesession
        WHERE source_mode='BATCH' AND status IN ('QUEUED','RETRY_WAIT')
          AND expires_at > NOW() AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        ORDER BY COALESCE(next_attempt_at, created_at), created_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE invoicesession ins
      SET status='PROCESSING', queue_attempts=queue_attempts+1,
          processing_started_at=NOW(), error_message=NULL, updated_at=NOW()
      FROM candidate WHERE ins.invoice_session_id=candidate.invoice_session_id
      RETURNING ins.*
    `);
    return rows[0] || null;
  }

  async function processNext() {
    if (busy || stopped) return;
    busy = true;
    try {
      const session = await claim();
      if (!session) return;
      try {
        const result = await processInvoiceSession(pool, session, {
          singleRoute: true,
          routeIndex: session.route_index,
          promptVersion: session.prompt_version || 'compact',
        });
        if (result.updated) console.log(`Bulk invoice ready: session ${session.invoice_session_id}, attempt ${session.queue_attempts}.`);
      } catch (error) {
        const info = failureDetails(error);
        const routeCount = Math.max(1, Number(info.diagnostics.route_count) || 1);
        const useDetailedPrompt = info.invalidOutput && session.prompt_version !== 'detailed';
        const nextRoute = useDetailedPrompt ? session.route_index : (Number(session.route_index) + 1) % routeCount;
        const nextPrompt = useDetailedPrompt ? 'detailed' : session.prompt_version || 'compact';
        if (info.retryable && Number(session.queue_attempts) < maxAttempts) {
          await pool.query(`UPDATE invoicesession SET status='RETRY_WAIT', route_index=$1, prompt_version=$2,
            next_attempt_at=NOW()+($3 || ' seconds')::interval, processing_started_at=NULL,
            error_message=$4, updated_at=NOW() WHERE invoice_session_id=$5 AND status='PROCESSING'`,
          [nextRoute, nextPrompt, String(info.delaySeconds), info.publicMessage, session.invoice_session_id]);
          console.warn(`Bulk invoice retry scheduled: session ${session.invoice_session_id}, status ${info.status || 'unknown'}, attempt ${session.queue_attempts}.`);
        } else {
          await pool.query(`UPDATE invoicesession SET status='FAILED', next_attempt_at=NULL,
            processing_started_at=NULL, error_message=$1, updated_at=NOW()
            WHERE invoice_session_id=$2 AND status='PROCESSING'`,
          [safeMessage(`Không xử lý được ảnh sau ${session.queue_attempts} lần thử. ${info.publicMessage}`), session.invoice_session_id]);
          console.error(`Bulk invoice failed: session ${session.invoice_session_id}:`, safeMessage(error?.message));
        }
      }
    } catch (error) {
      console.error('Bulk invoice worker error:', safeMessage(error?.message));
    } finally {
      busy = false;
      if (!stopped) setImmediate(processNext);
    }
  }

  recover().then(processNext).catch((error) => console.error('Unable to recover bulk invoice queue:', safeMessage(error.message)));
  const timer = setInterval(processNext, tickMs); timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = { startInvoiceOcrQueue, failureDetails };
