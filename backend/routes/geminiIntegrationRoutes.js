const express = require('express');
const { currentUserId } = require('../middleware/auth');
const { connectGemini, geminiStatus } = require('../services/geminiConnectionService');

module.exports = function geminiIntegrationRoutes(pool) {
  const router = express.Router();
  router.get('/status', async (req, res, next) => { try { res.json(await geminiStatus(pool, currentUserId(req))); } catch (error) { next(error); } });
  router.post('/connect', async (req, res, next) => {
    try { await connectGemini(pool, currentUserId(req), req.body || {}); res.json({ connected: true }); }
    catch (error) {
      if (error.code) return res.status(error.statusCode || 502).json({ error: error.message, code: error.code });
      next(error);
    }
  });
  return router;
};
