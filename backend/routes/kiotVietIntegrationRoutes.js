const express = require('express');
const { currentUserId } = require('../middleware/auth');
const { connectKiotViet, connectionStatus, syncConnection, disconnectKiotViet, checkConnection } = require('../services/kiotVietConnectionService');
const { KiotVietError } = require('../kiotviet');

const router = express.Router();

module.exports = function kiotVietIntegrationRoutes(pool) {
  const sendKiotError = (res, error) => {
    const codes = { AUTH:'KIOTVIET_AUTH_FAILED', ACCOUNT_UNAVAILABLE:'KIOTVIET_ACCOUNT_UNAVAILABLE', RETAILER:'KIOTVIET_RETAILER_FAILED', PERMISSION:'KIOTVIET_PERMISSION_DENIED', TIMEOUT:'KIOTVIET_TIMEOUT', NETWORK:'KIOTVIET_NETWORK_ERROR', SERVER:'KIOTVIET_SERVER_ERROR', NOT_CONNECTED:'KIOTVIET_NOT_CONNECTED', VALIDATION:'KIOTVIET_VALIDATION' };
    return res.status(error.statusCode || 502).json({ error: error.message, code: codes[error.code] || 'KIOTVIET_CONNECTION_ERROR' });
  };
  router.get('/status', async (req, res, next) => {
    try { res.json(await connectionStatus(pool, currentUserId(req))); } catch (error) { next(error); }
  });

  router.post('/connect', async (req, res, next) => {
    try {
      const connection = await connectKiotViet(pool, currentUserId(req), req.body || {});
      res.json({ connected: true, retailerCode: connection.retailer_code, retailerName: connection.retailer_name, lastSyncAt: connection.last_sync_at });
    } catch (error) { if (error instanceof KiotVietError) return sendKiotError(res, error); next(error); }
  });

  router.post('/check', async (req, res, next) => {
    try { res.json(await checkConnection(pool, currentUserId(req))); }
    catch (error) { if (error instanceof KiotVietError) return sendKiotError(res, error); next(error); }
  });

  router.post('/sync', async (req, res, next) => {
    try { res.json(await syncConnection(pool, currentUserId(req), req.query.lastModifiedFrom)); }
    catch (error) {
      if (!(error instanceof KiotVietError)) return next(error);
      if (error.code === 'AUTH') error.message = 'Kết nối KiotViet hiện không còn hợp lệ.\n\nHãy kiểm tra lại thông tin kết nối trong mục Sửa thông tin.';
      sendKiotError(res, error);
    }
  });

  router.post('/disconnect', async (req, res, next) => {
    try { await disconnectKiotViet(pool, currentUserId(req)); res.status(204).end(); } catch (error) { next(error); }
  });

  return router;
};
