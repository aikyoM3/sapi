#!/usr/bin/env node
// Live, small text request. No invoice images, matching, migrations, or KiotViet.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const { verifyGeminiApiKey, connectGemini } = require('../services/geminiConnectionService');
const { getGeminiEndpointSettings, redactGeminiSecrets } = require('../services/geminiClient');

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--connect-user' || !Number.isSafeInteger(Number(args[1])) || Number(args[1]) <= 0)) {
    throw new Error('Dùng: node scripts/test-gemini-connection.js [--connect-user USER_ID]. Lệnh gọi API thật; --connect-user còn lưu key mã hóa cho đúng tài khoản.');
  }
  const settings = getGeminiEndpointSettings();
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('Chưa đặt GEMINI_API_KEY trong backend/.env.');
  if (!args.length) {
    await verifyGeminiApiKey(key);
    console.log(JSON.stringify({ connected: true, ...settings, model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', saved: false }));
    return;
  }
  const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  try {
    const userId = Number(args[1]);
    const { rows } = await pool.query('SELECT user_id,username FROM users WHERE user_id=$1', [userId]);
    if (!rows[0]) throw new Error('Không tìm thấy tài khoản; chưa thay key nào.');
    // Reuse the application's verification + encrypted credential storage.
    // The saved key is changed only if verification succeeds.
    await connectGemini(pool, userId, { useDevCredentials: true });
    console.log(JSON.stringify({ connected: true, ...settings, model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', account: rows[0], saved: true }));
  } finally { await pool.end(); }
}

main().catch((error) => {
  console.error(redactGeminiSecrets(`${error.code || 'GEMINI_CONNECTION_FAILED'}: ${error.message}`, process.env.GEMINI_API_KEY));
  process.exitCode = 1;
});
