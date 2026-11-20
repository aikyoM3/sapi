// Recover an already-paid, successful diagnostic response without another API
// call. Keep the first failure in history and label unavailable timestamps null.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { backendRoot, outputDirectory, atomicJson, buildManifest, discoverDataset } = require('./geminiExperiment');
require('dotenv').config({ path: path.join(backendRoot, '.env') });

async function main() {
  const [name, diagnosticName] = process.argv.slice(2);
  if (!name || !/^[A-Za-z0-9._-]+\.json$/.test(diagnosticName || '')) throw new Error('Dùng: node scripts/experiments/recoverDiagnosticResult.js RUN_NAME DIAGNOSTIC_FILENAME.json');
  const out = outputDirectory(name);
  const lockPath = path.join(out, '.run.lock');
  const lock = await fs.open(lockPath, 'wx');
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), operation: 'recover_diagnostic' }));
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
    const current = await buildManifest(await discoverDataset(), { ...manifest.account, buyer: manifest.buyer });
    assert.equal(current.fingerprint, manifest.fingerprint, 'Protocol changed; do not mix results.');
    const source = path.join(out, 'history', diagnosticName);
    const diagnostic = JSON.parse(await fs.readFile(source, 'utf8'));
    assert.equal(diagnostic.protocol_fingerprint, manifest.fingerprint);
    assert.equal(manifest.fixture, false);
    assert.equal(diagnostic.error, null);
    assert(diagnostic.result?.raw_text && diagnostic.captures?.some((r) => r.status === 200));
    assert.deepEqual(JSON.parse(diagnostic.result.raw_text), diagnostic.result.raw_json);
    const image = manifest.images.find((i) => i.image_id === diagnostic.image_id);
    assert(image, 'Image is not in the manifest.');
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(backendRoot, image.source_path))).digest('hex'), image.image_sha256);
    const target = path.join(out, 'results', `${image.image_id}.json`);
    const previous = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.equal(previous.status, 'error', 'Never replace a successful result.');
    assert.equal(previous.protocol_fingerprint, manifest.fingerprint);
    const archive = path.join(out, 'history', `${image.image_id}-first-error-${Date.now()}-${crypto.randomUUID()}.json`);
    const result = diagnostic.result;
    const recovered = {
      ...image, protocol_fingerprint: manifest.fingerprint, fixture: false,
      provider: manifest.settings.provider, base_url: manifest.settings.baseUrl,
      status: 'success', started_at: null, finished_at: null, elapsed_ms: diagnostic.elapsed_ms,
      model_used: result.model_used, model_version: result.model_version,
      attempts: result.attempts, gemini: result.raw_json, pipeline_result: result.invoice,
      raw_text: result.raw_text, usage: result.usage || null, error: null,
      recovery: {
        source: path.relative(out, source).split(path.sep).join('/'),
        archived_error: path.relative(out, archive).split(path.sep).join('/'),
        recovered_at: new Date().toISOString(),
        note: 'Real successful diagnostic response, no new API call. The diagnostic measured elapsed_ms but did not record exact extraction timestamps; these remain null.',
      },
    };
    await fs.rename(target, archive);
    await atomicJson(target, recovered);
    console.log(JSON.stringify({ recovered: image.image_id, items: result.raw_json.items.length, source: recovered.recovery.source, archived_error: recovered.recovery.archived_error, api_calls: 0 }));
  } finally { await lock.close(); await fs.unlink(lockPath); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
