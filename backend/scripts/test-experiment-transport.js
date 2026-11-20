const assert = require('node:assert/strict');
const { withTransportDiagnostics } = require('./experiments/captureGeminiTransport');

async function main() {
  process.env.GEMINI_BASE_URL = 'https://api.shopaikey.com';
  const original = global.fetch;
  const payload = { candidates: [{ content: { parts: [{ functionCall: { name: 'OFFLINE_TOOL', args: { input: 'OFFLINE_ONLY' } } }] } }] };
  const request = { method: 'POST', headers: { 'x-goog-api-key': 'OFFLINE' }, body: 'OFFLINE_REQUEST' };
  const stub = async (url, init) => {
    assert.equal(url, 'https://api.shopaikey.com/v1beta/models/OFFLINE:generateContent');
    assert.equal(init, request, 'Do not modify request options.');
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  global.fetch = stub;
  try {
    const extractor = async () => {
      const response = await fetch('https://api.shopaikey.com/v1beta/models/OFFLINE:generateContent', request);
      assert.deepEqual(await response.json(), payload, 'Capture must not consume the original response.');
      throw Object.assign(new Error('OFFLINE empty text'), { diagnostics: { model_used: 'OFFLINE' } });
    };
    await assert.rejects(withTransportDiagnostics(extractor)([], {}), (error) => {
      assert.equal(error.diagnostics.model_used, 'OFFLINE');
      assert.deepEqual(error.diagnostics.transport_responses[0].body, payload);
      assert.equal(error.diagnostics.transport_responses[0].http_status, 200);
      return true;
    });
    assert.equal(global.fetch, stub);
    const success = { raw_json: { marker: 'OFFLINE' } };
    assert.equal(await withTransportDiagnostics(async () => success)([], {}), success);
    assert.equal(global.fetch, stub);
    console.log('PASS: experiment transport logs preserve error payloads, request/response content, error metadata and original fetch. No network calls.');
  } finally { global.fetch = original; }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
