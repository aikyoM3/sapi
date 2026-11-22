const { processInvoiceSession } = require('./invoiceSessionProcessingService');
const { probeGeminiRoute } = require('./geminiInvoiceService');
const { loadGeminiConnection } = require('./geminiConnectionService');

const safeMessage = (value, max = 1000) => String(value || '').trim().slice(0, max);

function failureDetails(error) {
  const diagnostics = error?.diagnostics || {};
  const lastAttempt = diagnostics.attempts?.at(-1) || {};
  const status = Number(lastAttempt.http_status || error?.statusCode || error?.status) || null;
  const raw = `${error?.message || ''} ${lastAttempt.error || ''}`;
  const invalidOutput = Boolean(diagnostics.prompt_failures?.length) || /response rỗng|JSON không hợp lệ|không đúng schema/i.test(raw);
  const retryable = invalidOutput || [401, 402, 403, 404, 408, 429, 500, 502, 503, 504].includes(status)
    || /abort|timeout|timed out|fetch failed|model_not_found|no available channel|rate.limit/i.test(raw);
  const blockRouteForBatch = [401, 402, 403, 404, 429].includes(status)
    || /model_not_found|no available channel|rate.?limit|quota|request.{0,20}block|block.{0,20}request|api.?key.{0,20}invalid|permission denied/i.test(raw);
  const deadlineExceeded = status === 504 || /deadline exceeded|deadline_expired|deadline expired/i.test(raw);
  const quotaExceeded = status === 429 || /quota exceeded|rate.?limit/i.test(raw);
  const publicMessage = status === 429 || /rate.limit/i.test(raw)
    ? 'Dịch vụ đang giới hạn tần suất. Hệ thống sẽ tự thử lại.'
    : status === 504 || /timeout|timed out|deadline/i.test(raw)
      ? 'Lần xử lý vừa rồi quá thời gian. Hệ thống sẽ tự thử lại.'
      : /model_not_found|no available channel/i.test(raw)
        ? 'Dịch vụ tạm thời chưa có kênh xử lý. Hệ thống sẽ tự thử lại.'
        : invalidOutput
          ? 'Kết quả trả về chưa đúng định dạng. Hệ thống sẽ thử lại.'
          : 'Chưa xử lý được ảnh. Hệ thống sẽ tự thử lại.';
  const finalMessage = status === 429 || /rate.limit/i.test(raw)
    ? 'Dịch vụ đang giới hạn tần suất trên các tuyến khả dụng.'
    : status === 504 || /timeout|timed out|deadline/i.test(raw)
      ? 'Các tuyến xử lý khả dụng không phản hồi trước thời hạn.'
      : invalidOutput
        ? 'Các kết quả trả về không đúng định dạng yêu cầu.'
        : 'Không còn tuyến xử lý khả dụng cho ảnh này.';
  return { diagnostics, status, invalidOutput, retryable, blockRouteForBatch, deadlineExceeded, quotaExceeded, publicMessage, finalMessage };
}

function deadlineCooldownRoutes(info, routeIndex) {
  return info.deadlineExceeded && Number(routeIndex) < 2 ? [0, 1] : [];
}

function shouldProbeAfterQuota(info, routeIndex) {
  return Boolean(info.quotaExceeded && Number(routeIndex) >= 2);
}

async function markRouteForProbe(pool, userId, routeIndex, routeCount) {
  await pool.query(`INSERT INTO gemini_route_probe(user_id, route_index, route_count, reason, updated_at)
    VALUES($1,$2,$3,'QUOTA_EXCEEDED',NOW())
    ON CONFLICT(user_id,route_index) DO UPDATE SET
      route_count=EXCLUDED.route_count, reason=EXCLUDED.reason, updated_at=NOW()`,
  [userId, routeIndex, routeCount]);
}

async function pendingRouteProbe(pool, userId, routeIndex) {
  if (Number(routeIndex) < 2) return null;
  const { rows } = await pool.query(`SELECT route_count FROM gemini_route_probe
    WHERE user_id=$1 AND route_index=$2`, [userId, routeIndex]);
  return rows[0] || null;
}

async function clearRouteProbe(pool, userId, routeIndex) {
  await pool.query('DELETE FROM gemini_route_probe WHERE user_id=$1 AND route_index=$2', [userId, routeIndex]);
}

async function activateDeadlineCooldown(pool, userId, routeCount, hours) {
  const duration = Number.isFinite(hours) && hours > 0 ? hours : 12;
  await pool.query(`INSERT INTO gemini_route_cooldown
      (user_id, route_index, route_count, blocked_until, reason, updated_at)
    SELECT $1, route_index, $2, NOW()+($3 || ' hours')::interval, 'DEADLINE_EXCEEDED', NOW()
    FROM UNNEST($4::int[]) AS routes(route_index)
    ON CONFLICT(user_id, route_index) DO UPDATE SET
      route_count=EXCLUDED.route_count,
      blocked_until=GREATEST(gemini_route_cooldown.blocked_until, EXCLUDED.blocked_until),
      reason=EXCLUDED.reason, updated_at=NOW()`,
  [userId, Math.max(1, Number(routeCount) || 1), String(duration), [0, 1]]);
}

async function activeDeadlineCooldown(pool, userId, routeIndex) {
  if (Number(routeIndex) > 1) return null;
  const { rows } = await pool.query(`SELECT route_count, blocked_until
    FROM gemini_route_cooldown
    WHERE user_id=$1 AND route_index=$2 AND blocked_until>NOW()`, [userId, routeIndex]);
  return rows[0] || null;
}

function nextAttemptPlan(session, info, routeCount, maxAttempts) {
  const useDetailedPrompt = info.invalidOutput && session.prompt_version !== 'detailed';
  const nextRoute = useDetailedPrompt ? Number(session.route_index) : Number(session.route_index) + 1;
  const nextPrompt = useDetailedPrompt ? 'detailed' : session.prompt_version || 'compact';
  const routesRemain = useDetailedPrompt || nextRoute < routeCount;
  return {
    nextRoute,
    nextPrompt,
    shouldRetry: Boolean(info.retryable && routesRemain && Number(session.queue_attempts) < maxAttempts),
  };
}

function startInvoiceOcrQueue(pool) {
  const tickMs = Math.max(1000, Number(process.env.INVOICE_OCR_QUEUE_TICK_MS) || 3000);
  const maxAttempts = Math.max(1, Number(process.env.INVOICE_OCR_MAX_ATTEMPTS) || 8);
  const deadlineCooldownHours = Math.max(1, Number(process.env.GEMINI_DEADLINE_COOLDOWN_HOURS) || 12);
  // A permanent/rate-limit failure disables that route only for the current
  // batch. A new batch evaluates every route again, so temporary incidents do
  // not poison future uploads.
  const blockedRoutesByBatch = new Map();
  let busy = false;
  let stopped = false;

  async function recover() {
    await pool.query('DELETE FROM gemini_route_cooldown WHERE blocked_until <= NOW()');
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
      const batchKey = String(session.batch_token || session.invoice_session_id);
      const persistentCooldown = await activeDeadlineCooldown(pool, session.user_id, Number(session.route_index));
      if (persistentCooldown) {
        const nextRoute = 2;
        if (nextRoute >= Number(persistentCooldown.route_count)) {
          await pool.query(`UPDATE invoicesession SET status='FAILED', next_attempt_at=NULL,
            processing_started_at=NULL, error_message=$1, updated_at=NOW()
            WHERE invoice_session_id=$2 AND status='PROCESSING'`,
          [`Hai tuyến đầu đang tạm dừng đến ${new Date(persistentCooldown.blocked_until).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.`, session.invoice_session_id]);
          return;
        }
        await pool.query(`UPDATE invoicesession SET status='RETRY_WAIT', route_index=$1,
          next_attempt_at=NOW(), processing_started_at=NULL, error_message=$2, updated_at=NOW()
          WHERE invoice_session_id=$3 AND status='PROCESSING'`,
        [nextRoute, 'Hai tuyến đầu đang tạm dừng do quá thời hạn xử lý; chuyển sang tuyến tiếp theo.', session.invoice_session_id]);
        return;
      }
      const probeState = await pendingRouteProbe(pool, session.user_id, Number(session.route_index));
      if (probeState) {
        try {
          const connection = await loadGeminiConnection(pool, session.user_id);
          await probeGeminiRoute(connection, Number(session.route_index));
          await clearRouteProbe(pool, session.user_id, Number(session.route_index));
          console.log(`Gemini route ${session.route_index} probe passed for user ${session.user_id}; invoice processing resumed.`);
        } catch (error) {
          const nextRoute = Number(session.route_index) + 1;
          const message = 'Tuyến dự phòng vẫn chưa vượt qua kiểm tra quota; ảnh chưa được gửi tới tuyến này.';
          if (nextRoute >= Number(probeState.route_count)) {
            await pool.query(`UPDATE invoicesession SET status='FAILED', next_attempt_at=NULL,
              processing_started_at=NULL, error_message=$1, updated_at=NOW()
              WHERE invoice_session_id=$2 AND status='PROCESSING'`, [message, session.invoice_session_id]);
          } else {
            await pool.query(`UPDATE invoicesession SET status='RETRY_WAIT', route_index=$1,
              next_attempt_at=NOW(), processing_started_at=NULL, error_message=$2, updated_at=NOW()
              WHERE invoice_session_id=$3 AND status='PROCESSING'`, [nextRoute, message, session.invoice_session_id]);
          }
          console.warn(`Gemini route ${session.route_index} probe failed for user ${session.user_id}; invoice image was not sent.`);
          return;
        }
      }
      const blockedState = blockedRoutesByBatch.get(batchKey);
      if (blockedState?.routes.has(Number(session.route_index))) {
        const nextRoute = Number(session.route_index) + 1;
        if (nextRoute >= blockedState.routeCount) {
          await pool.query(`UPDATE invoicesession SET status='FAILED', next_attempt_at=NULL,
            processing_started_at=NULL, error_message=$1, updated_at=NOW()
            WHERE invoice_session_id=$2 AND status='PROCESSING'`,
          ['Không còn tuyến xử lý khả dụng cho ảnh này.', session.invoice_session_id]);
          return;
        }
        await pool.query(`UPDATE invoicesession SET status='RETRY_WAIT', route_index=$1,
          next_attempt_at=NOW(), processing_started_at=NULL, error_message=$2, updated_at=NOW()
          WHERE invoice_session_id=$3 AND status='PROCESSING'`,
        [nextRoute, 'Bỏ qua tuyến đã bị khóa trong lượt xử lý hàng loạt này.', session.invoice_session_id]);
        return;
      }
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
        if (deadlineCooldownRoutes(info, session.route_index).length) {
          await activateDeadlineCooldown(pool, session.user_id, routeCount, deadlineCooldownHours);
          console.warn(`Gemini routes 0-1 paused for user ${session.user_id} during ${deadlineCooldownHours} hours after a deadline error.`);
        }
        const requiresQuotaProbe = shouldProbeAfterQuota(info, session.route_index);
        if (requiresQuotaProbe) await markRouteForProbe(pool, session.user_id, Number(session.route_index), routeCount);
        if (info.blockRouteForBatch && !requiresQuotaProbe) {
          const state = blockedRoutesByBatch.get(batchKey) || { routeCount, routes: new Set() };
          state.routeCount = routeCount;
          state.routes.add(Number(session.route_index));
          blockedRoutesByBatch.set(batchKey, state);
        }
        const plan = nextAttemptPlan(session, info, routeCount, maxAttempts);
        if (plan.shouldRetry) {
          await pool.query(`UPDATE invoicesession SET status='RETRY_WAIT', route_index=$1, prompt_version=$2,
            next_attempt_at=NOW()+($3 || ' seconds')::interval, processing_started_at=NULL,
            error_message=$4, updated_at=NOW() WHERE invoice_session_id=$5 AND status='PROCESSING'`,
          [plan.nextRoute, plan.nextPrompt, '0', info.publicMessage, session.invoice_session_id]);
          console.warn(`Bulk invoice retry scheduled: session ${session.invoice_session_id}, status ${info.status || 'unknown'}, attempt ${session.queue_attempts}.`);
        } else {
          await pool.query(`UPDATE invoicesession SET status='FAILED', next_attempt_at=NULL,
            processing_started_at=NULL, error_message=$1, updated_at=NOW()
            WHERE invoice_session_id=$2 AND status='PROCESSING'`,
          [safeMessage(`Không xử lý được ảnh sau ${session.queue_attempts} lần thử. ${info.finalMessage}`), session.invoice_session_id]);
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

module.exports = { startInvoiceOcrQueue, failureDetails, nextAttemptPlan, deadlineCooldownRoutes, shouldProbeAfterQuota };
