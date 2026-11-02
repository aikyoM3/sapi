const express = require('express');
const fixtures = require('./fixtures/kiotviet.json');

const purchaseOrders = [];
let nextPurchaseOrderId = 95001;

function requireMockAuth(req, res, next) {
  if (req.get('Authorization') !== 'Bearer sapi-mock-access-token') return res.status(401).json({ error: 'invalid_token' });
  if (String(req.get('Retailer') || '').toLowerCase() !== fixtures.retailer) return res.status(404).json({ error: 'retailer_not_found' });
  next();
}

function paged(data) {
  return { total: data.length, pageSize: 100, data, retailerName: fixtures.retailerName };
}

module.exports = function kiotVietMockRoutes() {
  const router = express.Router();
  router.post('/connect/token', (req, res) => {
    if (!req.body?.client_id || !req.body?.client_secret || req.body.grant_type !== 'client_credentials') return res.status(401).json({ error: 'invalid_client' });
    res.json({ access_token: 'sapi-mock-access-token', expires_in: 3600, token_type: 'Bearer' });
  });
  router.use(requireMockAuth);
  router.get('/branches', (_req, res) => res.json(paged(fixtures.branches)));
  router.get('/categories', (_req, res) => res.json(paged(fixtures.categories)));
  router.get('/suppliers', (_req, res) => res.json(paged(fixtures.suppliers)));
  router.get('/products', (_req, res) => res.json(paged(fixtures.products)));
  router.post('/purchaseorders', (req, res) => {
    const payload = req.body || {};
    const details = payload.purchaseOrderDetails;
    if (!Number.isFinite(Number(payload.branchId)) || !payload.supplier?.name || !Array.isArray(details) || !details.length
      || details.some((item) => !item.productCode || !Number.isFinite(Number(item.quantity)) || !Number.isFinite(Number(item.price)))) {
      return res.status(400).json({ error: 'invalid_purchase_order', message: 'Payload phiếu nhập không hợp lệ.' });
    }
    if (details.some((item) => item.productCode === 'MOCK-FAIL')) return res.status(503).json({ error: 'mock_purchase_order_failure' });
    const order = { id: nextPurchaseOrderId++, code: `PNM${String(purchaseOrders.length + 1).padStart(6, '0')}`, ...payload, createdDate: new Date().toISOString() };
    purchaseOrders.push(order);
    res.status(201).json(order);
  });
  router.get('/purchaseorders', (_req, res) => res.json(paged(purchaseOrders)));
  return router;
};

module.exports.purchaseOrders = purchaseOrders;
