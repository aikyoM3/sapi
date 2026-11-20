const { GOOGLE_BASE_URL, createGeminiClient, getGeminiEndpointSettings, GeminiConfigurationError } = require('./geminiClient');
const { encryptSecret, decryptSecret } = require('./integrationEncryption');

const devEnabled = () => process.env.GEMINI_DEV_USE_ENV_KEY === 'true';
const envKey = () => String(process.env.GEMINI_API_KEY || '').trim();

function developmentConnections() {
  const connections = [];
  for (let index = 1; index <= 5; index += 1) {
    const apiKey = String(process.env[`GEMINI_API_KEY_${index}`] || '').trim();
    const baseUrl = String(process.env[`GEMINI_BASE_URL_${index}`] || '').trim();
    if (!apiKey && !baseUrl) continue;
    if (!apiKey) throw new GeminiConfigurationError(`GEMINI_API_KEY_${index} đang trống.`);
    connections.push({ apiKey, ...getGeminiEndpointSettings(baseUrl || GOOGLE_BASE_URL) });
  }
  // Preserve the original pair as the final fallback so existing deployments
  // keep working while numbered providers are introduced gradually.
  if (envKey()) {
    const legacy = { apiKey: envKey(), ...getGeminiEndpointSettings() };
    if (!connections.some((item) => item.apiKey === legacy.apiKey && item.baseUrl === legacy.baseUrl)) connections.push(legacy);
  }
  return connections;
}

function personalEndpoint(baseUrl = GOOGLE_BASE_URL) {
  const endpoint = getGeminiEndpointSettings(baseUrl);
  // Custom personal endpoints still need server approval to prevent SSRF.
  const allowed = [GOOGLE_BASE_URL,
    ...String(process.env.GEMINI_ALLOWED_BASE_URLS || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => getGeminiEndpointSettings(s).baseUrl)];
  if (!allowed.includes(endpoint.baseUrl)) throw Object.assign(new Error('Host chưa được quản trị viên cho phép. Host tùy chỉnh phải hỗ trợ giao thức Gemini API.'), { statusCode: 400, code: 'GEMINI_HOST_NOT_ALLOWED' });
  return endpoint;
}

async function verifyGeminiApiKey(apiKey, endpoint = getGeminiEndpointSettings()) {
  try {
    const ai = createGeminiClient(apiKey, { timeoutMs: 15000, baseUrl: endpoint.baseUrl });
    await ai.models.generateContent({
      model: String(process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim(),
      contents: 'Reply with OK.',
      config: { maxOutputTokens: 5, temperature: 0, httpOptions: { timeout: 15000 } },
    });
  } catch (error) {
    if (error.code === 'GEMINI_CONFIGURATION_ERROR') throw error;
    const status = Number(error?.status || error?.statusCode);
    if (status === 401 || (status === 400 && /API_KEY_INVALID|API key not valid|invalid api.?key/i.test(error.message || ''))) throw Object.assign(new Error('Gemini API Key không hợp lệ. Hãy kiểm tra lại API Key hoặc tạo key mới.'), { statusCode: 400, code: 'GEMINI_INVALID_API_KEY' });
    if (status === 400) throw Object.assign(new Error('API từ chối yêu cầu kiểm tra. Hãy kiểm tra cấu hình model và khả năng hỗ trợ API; lỗi này chưa đủ để kết luận key không hợp lệ.'), { statusCode: 400, code: 'GEMINI_REQUEST_REJECTED' });
    if ([403, 404].includes(status)) throw Object.assign(new Error('Không thể sử dụng model Gemini hiện tại. Hãy kiểm tra tên model, quyền API và hạn chế của API Key.'), { statusCode: 400, code: 'GEMINI_MODEL_UNAVAILABLE' });
    if (status === 429) throw Object.assign(new Error('Gemini API hiện đã đạt giới hạn sử dụng. Vui lòng thử lại sau hoặc kiểm tra quota của API Key.'), { statusCode: 429, code: 'GEMINI_QUOTA_EXCEEDED' });
    if (status === 402) throw Object.assign(new Error('API không đủ credit hoặc chưa kích hoạt thanh toán. Hãy kiểm tra số dư tại nhà cung cấp đang dùng.'), { statusCode: 402, code: 'GEMINI_PAYMENT_REQUIRED' });
    if (error.name === 'AbortError' || /timeout|timed out/i.test(error.message || '')) throw Object.assign(new Error('Kiểm tra kết nối Gemini quá thời gian chờ. Vui lòng thử lại.'), { statusCode: 504, code: 'GEMINI_TIMEOUT' });
    throw Object.assign(new Error('Không thể kết nối tới Gemini. Hãy kiểm tra kết nối mạng và thử lại.'), { statusCode: 502, code: 'GEMINI_CONNECTION_ERROR' });
  }
}

// Versioned connection metadata is encrypted in the existing encrypted column.
// No schema migration. Development records reference env, never copy its key.
function readDescriptor(encrypted) {
  const value = decryptSecret(encrypted);
  if (value.startsWith('{')) {
    let saved;
    try { saved = JSON.parse(value); } catch { throw new GeminiConfigurationError('Cấu hình Gemini đã lưu không hợp lệ. Hãy kết nối lại.'); }
    if (saved.version !== 1 || !['google', 'personal', 'development'].includes(saved.source)) throw new GeminiConfigurationError('Cấu hình Gemini đã lưu không hợp lệ. Hãy kết nối lại.');
    return saved;
  }
  // Legacy copies of the current env key retain development routing. All other
  // old keys are personal Google connections; key-prefix checks are guards only.
  return developmentConnections().some((item) => item.apiKey === value) ? { source: 'development' } : { source: 'google', apiKey: value };
}

function resolveDescriptor(saved) {
  if (saved.source === 'google' || saved.source === 'personal') {
    if (typeof saved.apiKey !== 'string' || !saved.apiKey.trim()) throw new GeminiConfigurationError('API Key Google đã lưu bị trống. Hãy kết nối lại.');
    return { source: 'stored', apiKey: saved.apiKey.trim(), ...personalEndpoint(saved.source === 'google' ? GOOGLE_BASE_URL : saved.baseUrl || GOOGLE_BASE_URL) };
  }
  if (!devEnabled()) throw new GeminiConfigurationError('Kết nối development đã bị tắt. Hãy cấu hình API Key Google riêng.');
  const connections = developmentConnections();
  if (!connections.length) throw Object.assign(new Error('Chưa cấu hình API key development trong backend/.env.'), { statusCode: 503, code: 'GEMINI_KEY_REQUIRED' });
  // The browser cannot select/override or discover the development host.
  return { source: 'development', ...connections[0], fallbackConnections: connections.slice(1) };
}

async function connectGemini(pool, userId, body) {
  const useDev = body.useDevCredentials === true;
  if (useDev && !devEnabled()) throw Object.assign(new Error('Chức năng dùng Gemini development chưa được bật.'), { statusCode: 403, code: 'GEMINI_DEVELOPMENT_DISABLED' });
  const saved = useDev ? { version: 1, source: 'development' }
    : { version: 1, source: 'personal', baseUrl: personalEndpoint(String(body.baseUrl || GOOGLE_BASE_URL).trim()).baseUrl, apiKey: String(body.apiKey || '').trim() };
  if (!useDev && !saved.apiKey) throw Object.assign(new Error('Vui lòng nhập Gemini API Key.'), { statusCode: 400, code: 'GEMINI_KEY_REQUIRED' });
  const connection = resolveDescriptor(saved);
  if (!connection.apiKey) throw Object.assign(new Error('Vui lòng nhập Gemini API Key.'), { statusCode: 400, code: 'GEMINI_KEY_REQUIRED' });
  if (connection.source === 'development') {
    let verified = false; let lastError;
    for (const candidate of [connection, ...(connection.fallbackConnections || [])]) {
      try { await verifyGeminiApiKey(candidate.apiKey, candidate); verified = true; break; }
      catch (error) { lastError = error; }
    }
    if (!verified) throw lastError;
  } else await verifyGeminiApiKey(connection.apiKey, connection);
  await pool.query(`INSERT INTO gemini_connections(user_id,api_key_encrypted) VALUES($1,$2)
    ON CONFLICT(user_id) DO UPDATE SET api_key_encrypted=EXCLUDED.api_key_encrypted,status='CONNECTED',connected_at=NOW(),last_verified_at=NOW()`, [userId, encryptSecret(JSON.stringify(saved))]);
}

async function geminiStatus(pool, userId) {
  const { rows } = await pool.query('SELECT api_key_encrypted,status,last_verified_at FROM gemini_connections WHERE user_id=$1', [userId]);
  const row = rows[0];
  let devCredentialsAvailable = false;
  try { devCredentialsAvailable = devEnabled() && developmentConnections().length > 0; } catch { devCredentialsAvailable = false; }
  const info = { connected: false, source: null, lastVerifiedAt: row?.last_verified_at || null, devCredentialsAvailable,
    baseUrl: GOOGLE_BASE_URL };
  if (row && row.status !== 'CONNECTED') return info;
  try {
    const saved = row ? readDescriptor(row.api_key_encrypted) : null;
    if (!saved) return info;
    const { source, baseUrl, provider, apiKey } = resolveDescriptor(saved);
    return source === 'development' ? { ...info, connected: Boolean(apiKey), source }
      : { ...info, connected: Boolean(apiKey), source, baseUrl, provider };
  } catch (error) {
    return { ...info, error: 'Kết nối Gemini cần được cấu hình lại.', code: error.code || 'GEMINI_CONFIGURATION_ERROR' };
  }
}

async function loadGeminiConnection(pool, userId) {
  const { rows } = await pool.query('SELECT api_key_encrypted,status FROM gemini_connections WHERE user_id=$1', [userId]);
  if (rows[0]) {
    if (rows[0].status !== 'CONNECTED') throw new GeminiConfigurationError('Kết nối Gemini cần được cấu hình lại.');
    return resolveDescriptor(readDescriptor(rows[0].api_key_encrypted));
  }
  throw Object.assign(new Error('Account chưa cấu hình Gemini API.'), { statusCode: 409, code: 'GEMINI_NOT_CONNECTED' });
}

async function loadGeminiApiKey(pool, userId) {
  return (await loadGeminiConnection(pool, userId)).apiKey;
}

module.exports = { verifyGeminiApiKey, connectGemini, geminiStatus, loadGeminiApiKey, loadGeminiConnection, developmentConnections };
