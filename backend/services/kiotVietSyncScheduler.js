const { syncConnection } = require('./kiotVietConnectionService');

// This process-local scheduler is intentionally opt-in. It is suitable for the
// single Node.js deployment used by SAPI; multi-instance deployments should use
// a shared job runner instead.
function startKiotVietSyncScheduler(pool) {
  const tickMs = Math.max(30_000, Number(process.env.KIOTVIET_SCHEDULER_TICK_MS) || 60_000);
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const { rows } = await pool.query(`
        SELECT user_id, last_sync_at
        FROM kiotviet_connections
        WHERE status = 'CONNECTED' AND sync_enabled = TRUE
          AND (next_sync_at IS NULL OR next_sync_at <= NOW())
        ORDER BY next_sync_at NULLS FIRST
      `);
      for (const row of rows) {
        // Claim the next execution before contacting KiotViet, so a slow call
        // cannot be duplicated by the next scheduler tick.
        const claimed = await pool.query(`
          UPDATE kiotviet_connections
          SET next_sync_at = NOW() + (sync_interval_minutes || ' minutes')::interval,
              last_sync_error = NULL, updated_at = NOW()
          WHERE user_id = $1 AND sync_enabled = TRUE
            AND (next_sync_at IS NULL OR next_sync_at <= NOW())
          RETURNING user_id
        `, [row.user_id]);
        if (!claimed.rowCount) continue;
        try {
          await syncConnection(pool, row.user_id, row.last_sync_at ? row.last_sync_at.toISOString() : undefined);
        } catch (error) {
          await pool.query('UPDATE kiotviet_connections SET last_sync_error=$1, updated_at=NOW() WHERE user_id=$2', [String(error.message || 'Đồng bộ tự động thất bại.').slice(0, 1000), row.user_id]);
          console.warn(`KiotViet automatic sync failed for user ${row.user_id}:`, error.message);
        }
      }
    } catch (error) {
      console.error('KiotViet automatic sync scheduler failed:', error.message);
    } finally { running = false; }
  }

  const timer = setInterval(tick, tickMs);
  timer.unref();
  setImmediate(tick);
  return () => clearInterval(timer);
}

module.exports = { startKiotVietSyncScheduler };
