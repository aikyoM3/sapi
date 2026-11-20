// Offline: verifies the scheduled canary/recovery behavior, never calls Gemini.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const exp = require('./experiments/geminiExperiment');

async function main() {
  const dataset = await exp.discoverDataset();
  const manifest = await exp.buildManifest(dataset, { user_id: 0, username: 'OFFLINE_RECOVERY', buyer: {} }, true);
  const out = exp.outputDirectory(`selftest-recovery-${Date.now()}`);
  let calls = 0;
  const failure = async () => { calls++; throw Object.assign(new Error('Offline 503'), { statusCode: 503, diagnostics: { attempts: [{ model: 'OFFLINE', status: 'error', http_status: 503 }] } }); };
  const opts = { out, manifest, apiKey: 'OFFLINE', extract: failure, stopOnError: true, log: () => {} };
  assert.equal((await exp.runExperiment(opts)).called, 1); assert.equal(calls, 1);
  assert.equal((await exp.runExperiment({ ...opts, retryErrors: true })).called, 1); assert.equal(calls, 2);
  const success = async () => { calls++; return { invoice: {}, raw_json: {}, raw_text: '{}', model_used: 'OFFLINE', attempts: [] }; };
  assert.equal((await exp.runExperiment({ ...opts, retryErrors: true, extract: success, limit: 1 })).called, 1);
  const records = await exp.loadResults(out); assert.equal(records.records[0].status, 'success');
  assert.equal((await fs.readdir(path.join(out, 'history'))).length, 2);
  const lock = path.join(out, '.run.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(exp.recoverStaleLock(out), /vẫn còn/);
  await fs.unlink(lock); // Only this test's own generated lock.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  await new Promise((resolve) => child.once('exit', resolve));
  await fs.writeFile(lock, JSON.stringify({ pid: child.pid }));
  await exp.recoverStaleLock(out);
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
  assert(!exp.retryableRecord({ status: 'error', attempts: [{ status: 'success' }], error: { status: 502 } }));
  assert(!exp.retryableRecord({ status: 'error', error: { status: 401 } }));
  console.log('PASS: one failed canary stops batch, explicit retry archives history, success not re-called, live lock protected, dead lock archived, permanent/schema errors not retried.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
