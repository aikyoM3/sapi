// Offline fixtures only. Never calls an AI provider or edits research outputs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const exp = require('./experiments/geminiExperiment');

async function main() {
  const dataset = await exp.discoverDataset();
  const manifest = await exp.buildManifest(dataset, { user_id: 0, username: 'OFFLINE_SELECTED_RETRY', buyer: {} }, true);
  const out = exp.outputDirectory(`selftest-selected-retry-${Date.now()}`);
  const ids = ['IN-12', 'VT-26'];
  let count = 0;
  const result = { invoice: {}, raw_json: {}, raw_text: '{}', model_used: 'OFFLINE', model_version: 'OFFLINE', attempts: [] };
  const extract = async () => {
    const id = manifest.images[count++].image_id;
    if (ids.includes(id)) throw Object.assign(new Error('OFFLINE invalid JSON response'), { statusCode: 502, diagnostics: { attempts: [{ status: 'success', model: 'OFFLINE' }] } });
    return result;
  };
  const opts = { out, manifest, apiKey: 'OFFLINE', extract, log: () => {} };
  await exp.runExperiment(opts);
  const before = await fs.readFile(path.join(out, 'results', 'VT-16.json'), 'utf8');
  const blocked = await exp.runExperiment({ ...opts, retryErrors: true });
  assert.equal(blocked.called, 0); assert.equal(blocked.blocked, 'IN-12');
  let retried = 0;
  const success = async () => { retried++; return result; };
  const done = await exp.runExperiment({ ...opts, extract: success, retryImageIds: ids });
  assert.equal(done.called, 2); assert.equal(done.skipped, 24); assert.equal(retried, 2);
  assert.equal((await fs.readdir(path.join(out, 'history'))).length, 2);
  assert.equal(await fs.readFile(path.join(out, 'results', 'VT-16.json'), 'utf8'), before);
  assert.equal((await exp.runExperiment({ ...opts, extract: success, retryImageIds: ids })).called, 0);
  await assert.rejects(exp.runExperiment({ ...opts, retryImageIds: ['UNKNOWN'] }), /không thuộc manifest/);
  console.log('PASS: explicit selected retry calls only the two failed images, archives both failures, preserves every successful result and keeps automatic schema-error retries blocked. No network calls.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
