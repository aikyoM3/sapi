// Offline self-test only. Global fetch is disabled and the SDK is replaced in
// this process. Outputs are clearly marked fixture, never real Gemini results.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sdkPath = require.resolve('@google/genai');
const sdk = require(sdkPath);
const originalFetch = global.fetch;
global.fetch = () => { throw new Error('Network is forbidden in the offline experiment test.'); };
const key = 'offline-secret-must-not-appear';
let captures = [];
const baseInvoice = () => ({ supplier: { name: 'Cửa hàng thử, "Bánh kẹo"', phone: null, address: 'Địa chỉ\nDòng 2', tax_code: '123' }, invoice: { number: '0001', date: null }, items: [{ name: 'Bánh "kẹo", xoài\n180g', quantity: 2, unit: 'Gói', package_quantity: null, package_unit: null, unit_price: 11, price_unit: 'Gói', total_price: 999, line_type: 'PRODUCT', line_status: 'ACTIVE', status_reason: null }], promotions: [], total_amount: 777.88 });
require.cache[sdkPath].exports = { ...sdk, GoogleGenAI: class {
  constructor() { this.models = { generateContent: async (request) => {
    captures.push(request);
    if (request.model === 'test-primary') throw Object.assign(new Error('offline high demand'), { status: 503 });
    return { text: JSON.stringify(baseInvoice()), modelVersion: 'test-version', usageMetadata: { totalTokenCount: 1 } };
  } }; }
} };
const servicePath = require.resolve('../services/geminiInvoiceService');
delete require.cache[servicePath];
const service = require(servicePath);
const experiment = require('./experiments/geminiExperiment');

async function main() {
  const oldModel = process.env.GEMINI_MODEL; const oldFallback = process.env.GEMINI_FALLBACK_MODEL;
  try {
    process.env.GEMINI_MODEL = 'test-primary'; process.env.GEMINI_FALLBACK_MODEL = 'test-fallback';
    const details = await service.extractInvoiceFromImagesDetailed([{ buffer: Buffer.from('offline'), mimetype: 'image/jpeg' }], { apiKey: key, buyer: { tax_code: '123' } });
    assert.equal(captures.length, 3); assert.equal(details.model_used, 'test-fallback'); assert.equal(details.model_version, 'test-version');
    assert.equal(details.raw_json.supplier.name, baseInvoice().supplier.name); assert.equal(details.invoice.supplier.name, null);
    assert.equal(details.raw_json.items[0].total_price, 999); // Never recompute 2*11.
    assert.equal(captures[0].config.responseJsonSchema, service.invoiceSchema);
    assert(captures[0].contents[0].parts.some((part) => part.text?.includes('THÔNG TIN NGƯỜI MUA')));
    assert(captures[0].contents[0].parts.some((part) => part.text?.includes('Danh mục in sẵn')));
    assert(captures[0].contents[0].parts.some((part) => part.text?.includes('không đổi unit')));
  } finally {
    if (oldModel === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = oldModel;
    if (oldFallback === undefined) delete process.env.GEMINI_FALLBACK_MODEL; else process.env.GEMINI_FALLBACK_MODEL = oldFallback;
  }
  const dataset = await experiment.discoverDataset();
  assert.equal(dataset.images.length, 26);
  assert.equal(dataset.images.filter((i) => i.group === 'Viết tay').length, 7);
  assert(!dataset.images.some((i) => /test_images\/(13|21)\.jpg$/.test(i.source_path)));
  const manifest = await experiment.buildManifest(dataset, { user_id: 0, username: 'OFFLINE_FIXTURE', buyer: {} }, true);
  const out = experiment.outputDirectory(`selftest-gemini-${Date.now()}`);
  let calls = 0; let active = 0; let maximum = 0;
  const extract = async () => {
    active++; maximum = Math.max(active, maximum); const number = calls++;
    await new Promise((resolve) => setTimeout(resolve, 1)); active--;
    if (number === 1) throw new Error(`Offline failure with ${key}`);
    const g = baseInvoice();
    if (number === 0) g.items = Array.from({ length: 38 }, (_, i) => ({ ...g.items[0], name: i === 0 ? g.items[0].name : `Kiểm thử ${i}: ` + 'Tên hàng dài có tiếng Việt & < > '.repeat(i === 3 ? 25 : 2) }));
    if (number === 2) g.items = [];
    return { invoice: structuredClone(g), raw_json: g, raw_text: JSON.stringify(g), model_used: 'OFFLINE_FIXTURE', model_version: 'OFFLINE_FIXTURE', attempts: [], usage: null };
  };
  const opts = { out, manifest, apiKey: key, extract, log: () => {} };
  assert.equal((await experiment.runExperiment({ ...opts, limit: 3 })).called, 3);
  const errorJson = await fs.readFile(path.join(out, 'results', dataset.images[1].image_id + '.json'), 'utf8');
  assert(errorJson.includes('[REDACTED]')); assert(!errorJson.includes(key));
  assert.equal((await experiment.runExperiment(opts)).called, 23);
  assert.equal((await experiment.runExperiment(opts)).called, 0);
  assert.equal(calls, 26); assert.equal(maximum, 1);
  await assert.rejects(experiment.runExperiment({ ...opts, manifest: { ...manifest, fingerprint: 'changed' } }), /thay đổi/);
  const { records } = await experiment.loadResults(out);
  assert.equal(records.filter((r) => r.status === 'error').length, 1);
  const csv = await experiment.exportCsv(out, manifest, records);
  const bytes = await fs.readFile(csv); assert.equal(bytes.subarray(0,3).toString('hex'), 'efbbbf');
  await fs.appendFile(csv, '#manual-review-marker');
  assert.notEqual(await experiment.exportCsv(out, manifest, records), csv);
  assert((await fs.readFile(csv, 'utf8')).endsWith('#manual-review-marker'));
  // Use the clean second CSV for parsing checks; original remains untouched.
  const cleanCsv = await experiment.exportCsv(out, manifest, records);
  const python = process.env.PYTHON_EXE || 'python';
  const pdf = spawnSync(python, [path.join(__dirname, 'experiments/render_report.py'), '--run-dir', out], { encoding: 'utf8' });
  if (pdf.status !== 0) throw new Error(pdf.stderr || 'PDF failed');
  const check = spawnSync(python, [path.join(__dirname, 'experiments/check_fixture.py'), cleanCsv, path.join(out, 'review.pdf')], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error(check.stderr || 'CSV/PDF check failed');
  assert.deepEqual((await experiment.discoverDataset()).images, dataset.images);
  console.log('PASS: same prompt/schema/context, fallback metadata, raw vs pipeline, 26-image whitelist, sequential/resume, error redaction, config mismatch, CSV blanks/quotes/BOM and source hashes.');
  console.log(`Fixture output only: ${out}`); console.log(pdf.stdout.trim());
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; require.cache[sdkPath].exports = sdk; });
