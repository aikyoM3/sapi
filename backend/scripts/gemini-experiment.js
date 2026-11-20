#!/usr/bin/env node
// No server startup, migrations, invoice routes, matching, or KiotViet imports.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { loadGeminiConnection, geminiStatus, developmentConnections } = require('../services/geminiConnectionService');
const { extractInvoiceFromImagesDetailed } = require('../services/geminiInvoiceService');
const { withTransportDiagnostics } = require('./experiments/captureGeminiTransport');
const { backendRoot, discoverDataset, outputDirectory, buildManifest, runExperiment, loadResults, exportCsv, recoverStaleLock } = require('./experiments/geminiExperiment');

function options(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (['--retry-errors', '--stop-on-error', '--no-report'].includes(args[i])) { parsed[args[i].slice(2)] = true; continue; }
    if (!['--name', '--user-id', '--limit', '--python', '--retry-image'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error(`Tham số không hợp lệ: ${args[i]}`);
    const name = args[i].slice(2); const value = args[++i];
    if (name === 'retry-image') (parsed[name] ||= []).push(value);
    else parsed[name] = value;
  }
  return parsed;
}
async function readAccount(userId, needKey) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw new Error('Cần --user-id hợp lệ. Dùng lệnh users để xem tài khoản.');
  const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  let client;
  try {
    client = await pool.connect(); await client.query('BEGIN READ ONLY');
    const { rows } = await client.query('SELECT user_id,username,store_name,tax_code,address,phone,email FROM users WHERE user_id=$1', [Number(userId)]);
    if (!rows[0]) throw new Error('Không tìm thấy tài khoản.');
    const { user_id, username, ...buyer } = rows[0];
    let connection = needKey ? await loadGeminiConnection(client, user_id) : await geminiStatus(client, user_id);
    // geminiStatus intentionally masks the development endpoint from browser
    // consumers. This CLI plan is server-side, so let extraction settings read
    // the real development endpoint from .env without exposing the API key.
    if (!needKey && connection.source === 'development') {
      const chain = developmentConnections();
      connection = { source: 'development', baseUrl: chain[0]?.baseUrl, fallbackConnections: chain.slice(1).map(({ provider, baseUrl }) => ({ provider, baseUrl })) };
    }
    await client.query('COMMIT');
    return { account: { user_id, username, buyer }, apiKey: needKey ? connection.apiKey : null, connection };
  } finally { if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); } await pool.end(); }
}
async function listUsers() {
  const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  try { console.table((await pool.query('SELECT user_id,username,store_name FROM users ORDER BY user_id')).rows); } finally { await pool.end(); }
}
async function report(out, python) {
  const { manifest, records } = await loadResults(out);
  console.log('CSV:', await exportCsv(out, manifest, records));
  const result = spawnSync(python || process.env.PYTHON_EXE || 'python', [path.join(__dirname, 'experiments/render_report.py'), '--run-dir', out], { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Chưa xuất được PDF. Cài requirements-pdf.txt hoặc chỉ định --python. JSON/CSV đã lưu; chạy lại lệnh report, không gọi Gemini lại.');
}
async function main() {
  const command = process.argv[2] || 'help'; const opts = options(process.argv.slice(3));
  if (command === 'help') { console.log('Lệnh: images | users | plan --user-id N | run --user-id N [--name gemini-26] [--limit N] [--python python] [--retry-image IMAGE_ID ...] | report [--name gemini-26]\nrun gọi Gemini thật; plan/images/users/report không gọi Gemini. --retry-image là yêu cầu chủ động thử lại đúng ảnh chỉ định, kể cả lỗi JSON; không gọi lại ảnh đã thành công.'); return; }
  if (command === 'users') return listUsers();
  if (command === 'report') return report(outputDirectory(opts.name || 'gemini-26'), opts.python);
  if (!['images','plan','run'].includes(command)) throw new Error('Lệnh không hợp lệ. Dùng help.');
  const dataset = await discoverDataset();
  if (command === 'images') { console.table(dataset.images.map(({image_id,group,kind,source_path}) => ({image_id,group,kind,source_path}))); if (dataset.relocation) console.log(dataset.relocation); return; }
  const { account, apiKey, connection } = await readAccount(opts['user-id'], command === 'run');
  const manifest = await buildManifest(dataset, account, false, connection);
  const out = outputDirectory(opts.name || 'gemini-26');
  if (command === 'plan') { console.log(JSON.stringify({ total: dataset.images.length, account: manifest.account, buyer: manifest.buyer, settings: manifest.settings, out, fingerprint: manifest.fingerprint, relocation: dataset.relocation }, null, 2)); return; }
  const limit = opts.limit === undefined ? Infinity : Number(opts.limit);
  if (!(limit === Infinity || (Number.isInteger(limit) && limit > 0))) throw new Error('--limit phải là số nguyên dương.');
  if (opts['retry-errors'] || opts['retry-image']?.length) await recoverStaleLock(out);
  let stopping = false;
  const stop = () => { stopping = true; console.log('Sẽ dừng sau khi lưu request hiện tại. Không bấm Ctrl+C lần nữa nếu muốn giữ kết quả.'); };
  process.once('SIGINT', stop);
  try {
    const summary = await runExperiment({ out, manifest, apiKey, connection, limit, extract: withTransportDiagnostics(extractInvoiceFromImagesDetailed), shouldStop: () => stopping, retryErrors: Boolean(opts['retry-errors']), retryImageIds: opts['retry-image'] || [], stopOnError: Boolean(opts['stop-on-error']) });
    console.log(JSON.stringify(summary));
    if (!opts['no-report']) await report(out, opts.python);
  } finally { process.removeListener('SIGINT', stop); }
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { main, report };
