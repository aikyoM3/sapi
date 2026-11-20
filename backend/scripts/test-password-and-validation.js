// Isolated HTTP tests: in-memory database double, no real accounts or API calls.
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const createAuthRoutes = require('../routes/authRoutes');
const createInvoiceRoutes = require('../routes/invoiceSessionRoutes');

async function main() {
  const state = { hash: await bcrypt.hash('OldPassword123!', 4), sessions: ['current', 'other'], writes: 0 };
  let snapshot;
  const client = {
    async query(sql, values) {
      if (sql === 'BEGIN') snapshot = structuredClone(state);
      else if (sql === 'ROLLBACK' && snapshot) Object.assign(state, snapshot);
      else if (sql.startsWith('SELECT password_hash')) return { rows: [{ password_hash: state.hash }] };
      else if (sql.startsWith('UPDATE users SET password_hash')) { state.hash = values[0]; state.writes += 1; }
      else if (sql.startsWith('DELETE FROM user_session')) { assert.deepEqual(values, ['7', 'current']); state.sessions = ['current']; }
      else if (!['COMMIT', 'ROLLBACK'].includes(sql)) throw new Error(`Unexpected query: ${sql}`);
      return { rows: [] };
    }, release() {},
  };
  const pool = { async connect() { return client; } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.get('X-Test-User')) { req.session = { user: { userId: 7 } }; req.sessionID = 'current'; } next(); });
  app.use('/api/auth', createAuthRoutes(pool)); app.use(createInvoiceRoutes(pool));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, data, authenticated = true) {
    const response = await fetch(base + path, { method: path.includes('confirm') ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Test-User': '7' } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  }
  try {
    const good = { currentPassword: 'OldPassword123!', newPassword: 'NewPassword456!', confirmPassword: 'NewPassword456!' };
    assert.equal((await request('/api/auth/password', good, false)).status, 401);
    for (const data of [{ ...good, currentPassword: 'wrong' }, { ...good, confirmPassword: 'mismatch' }, { ...good, newPassword: 'short', confirmPassword: 'short' }, { ...good, newPassword: 'a'.repeat(73), confirmPassword: 'a'.repeat(73) }, { ...good, newPassword: good.currentPassword, confirmPassword: good.currentPassword }]) {
      assert.equal((await request('/api/auth/password', data)).status, 400);
    }
    assert.equal(state.writes, 0); assert.deepEqual(state.sessions, ['current', 'other']);
    assert.equal((await request('/api/auth/password', good)).status, 200);
    assert(await bcrypt.compare(good.newPassword, state.hash)); assert(!await bcrypt.compare(good.currentPassword, state.hash));
    assert.deepEqual(state.sessions, ['current']); assert.equal(state.writes, 1);
    assert.equal((await request('/api/auth/password', good)).status, 400);
    // Empty invoice and unreadable numerical fields must fail before any DB work/API.
    snapshot = undefined;
    assert.equal((await request('/api/invoice-sessions/test/confirm', { items: [] })).status, 400);
    for (const quantity of ['', null, 0, -1]) {
      assert.equal((await request('/api/invoice-sessions/test/confirm', { items: [{ productId: 1, quantity, unitPrice: 10 }] })).status, 400);
    }
    assert.equal((await request('/api/invoice-sessions/test/confirm', { items: [{ productId: 1, quantity: 2, unitPrice: '' }] })).status, 400);
    console.log('PASS: password validation, bcrypt update, other-session revocation, empty invoice and missing numbers. No live database modified.');
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
