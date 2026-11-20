// Offline only: the real SDK builds requests, but fetch never reaches a network.
const assert = require('node:assert/strict');
const { createGeminiClient, getGeminiEndpointSettings, redactGeminiSecrets } = require('../services/geminiClient');
const { extractInvoiceFromImagesDetailed, invoiceSchema } = require('../services/geminiInvoiceService');
const { verifyGeminiApiKey, connectGemini, loadGeminiApiKey, loadGeminiConnection, geminiStatus } = require('../services/geminiConnectionService');
const { encryptSecret, decryptSecret } = require('../services/integrationEncryption');
const { invoiceExtractionPrompt, compactInvoiceExtractionPrompt, detailedInvoiceExtractionPrompt } = require('../services/geminiInvoicePrompt');
const { buildManifest } = require('./experiments/geminiExperiment');

const savedEnv = { ...process.env };
const savedFetch = global.fetch;
const requests = [];
const gatewayKey = 'sk-OFFLINE_TEST_ONLY_NOT_A_REAL_CREDENTIAL';
const googleKey = 'AIzaOFFLINE_TEST_ONLY_NOT_A_REAL_CREDENTIAL';
const fixture = { supplier: { name: null, phone: null, address: null, tax_code: null }, invoice: { number: null, date: null }, items: [], promotions: [], total_amount: null };
let failureStatus = null;
let googleFailureStatus = null;
let invalidCompactOnce = false;
global.fetch = async (url, init) => {
  requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
  if (googleFailureStatus && String(url).startsWith('https://generativelanguage.googleapis.com/')) return new Response(JSON.stringify({ error: { code: googleFailureStatus, message: 'OFFLINE Google failure', status: 'UNKNOWN' } }), { status: googleFailureStatus });
  if (failureStatus) return new Response(JSON.stringify({ error: { code: failureStatus, message: 'OFFLINE test failure', status: 'UNKNOWN' } }), { status: failureStatus });
  const compactRequest = requests.at(-1).body.contents?.[0]?.parts?.some((part) => part.text === compactInvoiceExtractionPrompt);
  const text = invalidCompactOnce && compactRequest ? (invalidCompactOnce = false, 'not-json')
    : requests.at(-1).body.generationConfig?.responseMimeType === 'application/json' ? JSON.stringify(fixture) : 'OK';
  return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], modelVersion: 'OFFLINE_FIXTURE', usageMetadata: { totalTokenCount: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

async function main() {
  process.env.GEMINI_PROMPT_VERSION = 'compact';
  process.env.GEMINI_PROMPT_FALLBACK_ON_INVALID = 'true';
  for (let index = 1; index <= 5; index += 1) {
    delete process.env[`GEMINI_API_KEY_${index}`];
    delete process.env[`GEMINI_BASE_URL_${index}`];
  }
  delete process.env.GEMINI_BASE_URL;
  process.env.GOOGLE_GEMINI_BASE_URL = 'https://must-not-use.invalid';
  assert.deepEqual(getGeminiEndpointSettings(), { provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com' });
  assert.throws(() => createGeminiClient(gatewayKey), /GEMINI_BASE_URL/);
  await createGeminiClient(googleKey).models.generateContent({ model: 'gemini-3.6-flash', contents: 'OFFLINE' });
  assert(requests.at(-1).url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'));

  for (const bad of ['http://api.shopaikey.com', 'https://api.shopaikey.com/v1', 'https://api.shopaikey.com/v1beta', 'https://user:secret@api.shopaikey.com', 'https://api.shopaikey.com?key=secret', 'not-a-url']) {
    process.env.GEMINI_BASE_URL = bad;
    assert.throws(getGeminiEndpointSettings, { code: 'GEMINI_CONFIGURATION_ERROR' });
  }
  process.env.GEMINI_BASE_URL = 'https://api.shopaikey.com/';
  assert.equal(getGeminiEndpointSettings().provider, 'shopaikey');
  const before = requests.length;
  assert.throws(() => createGeminiClient(googleKey), /vẫn lưu key Google/);
  assert.equal(requests.length, before, 'Do not send Google credentials to a gateway.');

  process.env.GEMINI_MODEL = 'gemini-3.6-flash';
  process.env.GEMINI_FALLBACK_MODEL = 'gemini-3.8-flash';
  await verifyGeminiApiKey(gatewayKey);
  const verifyRequest = requests.at(-1);
  assert.equal(verifyRequest.url, 'https://api.shopaikey.com/v1beta/models/gemini-3.6-flash:generateContent');
  assert.equal(verifyRequest.headers.get('x-goog-api-key'), gatewayKey);

  const buyer = { store_name: 'OFFLINE BUYER' };
  const result = await extractInvoiceFromImagesDetailed([{ buffer: Buffer.from('OFFLINE IMAGE'), mimetype: 'image/jpeg' }], { apiKey: gatewayKey, buyer });
  const request = requests.at(-1);
  assert.equal(request.url, verifyRequest.url);
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(request.body.generationConfig.responseJsonSchema, invoiceSchema);
  assert(request.body.contents[0].parts.some((p) => p.text === invoiceExtractionPrompt));
  assert(request.body.contents[0].parts.some((p) => p.text?.includes(buyer.store_name)));
  assert.equal(result.model_used, 'gemini-3.6-flash');
  assert.deepEqual(result.raw_json, fixture);
  invalidCompactOnce = true;
  const promptFallback = await extractInvoiceFromImagesDetailed([{ buffer: Buffer.from('OFFLINE IMAGE'), mimetype: 'image/jpeg' }], { apiKey: gatewayKey, buyer });
  assert.equal(promptFallback.prompt_used, 'detailed');
  assert.equal(promptFallback.prompt_failures[0].prompt_version, 'compact');
  assert(requests.at(-1).body.contents[0].parts.some((part) => part.text === detailedInvoiceExtractionPrompt));

  process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
  process.env.GEMINI_DEV_USE_ENV_KEY = 'false';
  const queries = [];
  const accounts = new Map();
  const pool = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.startsWith('INSERT')) accounts.set(values[0], { api_key_encrypted: values[1], status: 'CONNECTED' });
    return { rows: sql.startsWith('SELECT') && accounts.has(values[0]) ? [accounts.get(values[0])] : [] };
  } };
  await connectGemini(pool, 12, { apiKey: googleKey });
  assert.equal(queries[0].values[0], 12);
  assert.notEqual(queries[0].values[1], googleKey);
  assert.equal(await loadGeminiApiKey(pool, 12), googleKey);
  assert(requests.at(-1).url.startsWith('https://generativelanguage.googleapis.com/'), 'Personal key verification ignores gateway env.');

  process.env.GEMINI_DEV_USE_ENV_KEY = 'true';
  process.env.GEMINI_API_KEY = gatewayKey;
  await connectGemini(pool, 99, { useDevCredentials: true });
  assert(!decryptSecret(accounts.get(99).api_key_encrypted).includes(gatewayKey), 'Development references env without copying its key.');
  assert.equal(await loadGeminiApiKey(pool, 12), googleKey, 'Enabling development never overrides an account personal key.');
  assert.equal(await loadGeminiApiKey(pool, 99), gatewayKey);
  assert.equal((await geminiStatus(pool, 12)).source, 'stored');
  assert.equal((await geminiStatus(pool, 99)).source, 'development');
  assert(!JSON.stringify(await geminiStatus(pool, 99)).includes('shopaikey'), 'Development host/provider stay backend-only.');
  assert.equal((await geminiStatus(pool, 777)).connected, false, 'New accounts must explicitly select credentials.');
  await assert.rejects(loadGeminiConnection(pool, 777), { code: 'GEMINI_NOT_CONNECTED' });
  for (const [id, host, key] of [[12, 'https://generativelanguage.googleapis.com', googleKey], [99, 'https://api.shopaikey.com', gatewayKey]]) {
    const connection = await loadGeminiConnection(pool, id);
    await extractInvoiceFromImagesDetailed([{ buffer: Buffer.from('OFFLINE'), mimetype: 'image/jpeg' }], { connection, buyer });
    assert(requests.at(-1).url.startsWith(`${host}/`));
    assert.equal(requests.at(-1).headers.get('x-goog-api-key'), key);
    const status = JSON.stringify(await geminiStatus(pool, id));
    assert(!status.includes(key), 'Status never returns credentials.');
  }
  const requestCount = requests.length;
  await assert.rejects(connectGemini(pool, 12, { apiKey: googleKey, baseUrl: 'https://api.shopaikey.com' }), { code: 'GEMINI_HOST_NOT_ALLOWED' });
  await assert.rejects(connectGemini(pool, 99, { apiKey: gatewayKey, baseUrl: 'https://untrusted.invalid' }), { code: 'GEMINI_HOST_NOT_ALLOWED' });
  assert.equal(requests.length, requestCount, 'Reject unsafe host before transmitting credentials.');
  process.env.GEMINI_ALLOWED_BASE_URLS = 'https://approved-gateway.invalid';
  await connectGemini(pool, 99, { apiKey: gatewayKey, baseUrl: 'https://approved-gateway.invalid/' });
  assert(requests.at(-1).url.startsWith('https://approved-gateway.invalid/'));
  assert.equal((await loadGeminiConnection(pool, 99)).baseUrl, 'https://approved-gateway.invalid');
  delete process.env.GEMINI_ALLOWED_BASE_URLS;
  await assert.rejects(loadGeminiConnection(pool, 99), { code: 'GEMINI_HOST_NOT_ALLOWED' });
  await connectGemini(pool, 99, { useDevCredentials: true, baseUrl: 'https://untrusted.invalid', apiKey: 'ignored' });
  assert(requests.at(-1).url.startsWith('https://api.shopaikey.com/'), 'Browser cannot override the development host.');
  assert.equal(requests.at(-1).headers.get('x-goog-api-key'), gatewayKey);
  assert.deepEqual(JSON.parse(decryptSecret(accounts.get(99).api_key_encrypted)), { version: 1, source: 'development' });

  process.env.GEMINI_API_KEY_1 = googleKey;
  process.env.GEMINI_BASE_URL_1 = 'https://generativelanguage.googleapis.com';
  const ordered = await loadGeminiConnection(pool, 99);
  assert.equal(ordered.provider, 'google');
  assert.equal(ordered.fallbackConnections.length, 1);
  assert.equal(ordered.fallbackConnections[0].provider, 'shopaikey');
  googleFailureStatus = 429;
  const failover = await extractInvoiceFromImagesDetailed([{ buffer: Buffer.from('OFFLINE'), mimetype: 'image/jpeg' }], { connection: ordered, buyer });
  googleFailureStatus = null;
  assert.equal(failover.provider_used, 'shopaikey');
  assert(failover.attempts.some((attempt) => attempt.provider === 'google' && attempt.status === 'error'));
  assert.equal(failover.attempts.at(-1).provider, 'shopaikey');

  delete process.env.GEMINI_API_KEY_1;
  delete process.env.GEMINI_BASE_URL_1;
  await connectGemini(pool, 99, { useDevCredentials: true });
  const rotatedKey = 'sk-OFFLINE_ROTATED_TEST_CREDENTIAL';
  process.env.GEMINI_API_KEY = rotatedKey;
  assert.equal(await loadGeminiApiKey(pool, 99), rotatedKey);
  assert.equal(await loadGeminiApiKey(pool, 12), googleKey);
  accounts.set(44, { status: 'CONNECTED', api_key_encrypted: encryptSecret(googleKey) });
  accounts.set(45, { status: 'CONNECTED', api_key_encrypted: encryptSecret(rotatedKey) });
  assert.equal((await loadGeminiConnection(pool, 44)).provider, 'google');
  assert.equal((await loadGeminiConnection(pool, 45)).provider, 'shopaikey');
  await connectGemini(pool, 99, { apiKey: googleKey });
  assert.equal((await loadGeminiConnection(pool, 99)).provider, 'google', 'Personal selection replaces development selection.');
  await connectGemini(pool, 99, { useDevCredentials: true });
  process.env.GEMINI_API_KEY = '';
  await assert.rejects(loadGeminiApiKey(pool, 99), { code: 'GEMINI_KEY_REQUIRED' });
  assert.equal((await geminiStatus(pool, 99)).connected, false);
  assert.equal(await loadGeminiApiKey(pool, 12), googleKey);
  process.env.GEMINI_DEV_USE_ENV_KEY = 'false';
  await assert.rejects(connectGemini(pool, 99, { useDevCredentials: true }), { code: 'GEMINI_DEVELOPMENT_DISABLED' });
  await assert.rejects(loadGeminiConnection(pool, 99), { code: 'GEMINI_CONFIGURATION_ERROR' });

  failureStatus = 400;
  await assert.rejects(verifyGeminiApiKey(googleKey, { baseUrl: 'https://generativelanguage.googleapis.com' }), { code: 'GEMINI_REQUEST_REJECTED' });
  failureStatus = 429;
  const beforeFailure = accounts.get(12).api_key_encrypted;
  await assert.rejects(connectGemini(pool, 12, { apiKey: googleKey }), { code: 'GEMINI_QUOTA_EXCEEDED' });
  assert.equal(accounts.get(12).api_key_encrypted, beforeFailure, 'Failed verification preserves last working connection.');
  failureStatus = 402;
  await assert.rejects(verifyGeminiApiKey(gatewayKey), { code: 'GEMINI_PAYMENT_REQUIRED' });
  const googleManifest = await buildManifest({ images: [], relocation: null, excluded_root_files: [] }, { user_id: 0, username: 'OFFLINE', buyer: {} }, true);
  delete process.env.GEMINI_BASE_URL;
  const otherManifest = await buildManifest({ images: [], relocation: null, excluded_root_files: [] }, { user_id: 0, username: 'OFFLINE', buyer: {} }, true);
  assert.notEqual(googleManifest.fingerprint, otherManifest.fingerprint);
  assert(googleManifest.client_sha256);
  assert.equal(googleManifest.settings.provider, 'shopaikey');
  assert.equal(otherManifest.settings.provider, 'google');
  const secretText = `key=${gatewayKey} ${googleKey} ${gatewayKey}`;
  assert(!redactGeminiSecrets(secretText, gatewayKey).includes(gatewayKey));
  assert(!redactGeminiSecrets(secretText).includes(googleKey));
  assert(!redactGeminiSecrets(secretText).includes(gatewayKey));
  console.log('PASS: native/gateway routing, SDK authentication, invalid endpoint/key guards, shared verification/extraction, unchanged prompt/schema/buyer context, encrypted account connection, credit errors, provider-isolated fingerprints and secret redaction. No network or real DB calls.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  global.fetch = savedFetch;
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
});
