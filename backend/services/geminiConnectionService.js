const { GoogleGenAI } = require('@google/genai');
const { encryptSecret, decryptSecret } = require('./integrationEncryption');

async function verifyGeminiApiKey(apiKey) {
  try {
    const ai = new GoogleGenAI({ apiKey });
    await ai.models.generateContent({
      model: String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
      contents: 'Reply with OK.',
      config: { maxOutputTokens: 5, temperature: 0, httpOptions: { timeout: 15000 } },
    });
  } catch (error) {
    const status = Number(error?.status || error?.statusCode);
    if ([400, 401].includes(status)) throw Object.assign(new Error('Gemini API Key không hợp lệ.\n\nHãy kiểm tra lại API Key hoặc tạo key mới.'), { statusCode: 400, code: 'GEMINI_INVALID_API_KEY' });
    if ([403, 404].includes(status)) throw Object.assign(new Error('API Key đã được nhận nhưng không thể sử dụng model Gemini hiện tại.\n\nHãy kiểm tra quyền API hoặc cấu hình model.'), { statusCode: 400, code: 'GEMINI_MODEL_UNAVAILABLE' });
    if (status === 429) throw Object.assign(new Error('Gemini API hiện đã đạt giới hạn sử dụng.\n\nVui lòng thử lại sau hoặc kiểm tra quota của API Key.'), { statusCode: 429, code: 'GEMINI_QUOTA_EXCEEDED' });
    throw Object.assign(new Error('Không thể kết nối tới Gemini.\n\nHãy kiểm tra kết nối mạng và thử lại.'), { statusCode: 502, code: 'GEMINI_CONNECTION_ERROR' });
  }
}

async function connectGemini(pool, userId, body) {
  const useDev = body.useDevCredentials === true;
  if (useDev && process.env.GEMINI_DEV_USE_ENV_KEY !== 'true') throw Object.assign(new Error('Chức năng dùng Gemini development chưa được bật.'), { statusCode: 403 });
  const apiKey = String(useDev ? process.env.GEMINI_API_KEY : body.apiKey || '').trim();
  if (!apiKey) throw Object.assign(new Error('Vui lòng nhập Gemini API Key.'), { statusCode: 400, code: 'GEMINI_KEY_REQUIRED' });
  await verifyGeminiApiKey(apiKey);
  await pool.query(`INSERT INTO gemini_connections(user_id,api_key_encrypted) VALUES($1,$2)
    ON CONFLICT(user_id) DO UPDATE SET api_key_encrypted=EXCLUDED.api_key_encrypted,status='CONNECTED',connected_at=NOW(),last_verified_at=NOW()`, [userId, encryptSecret(apiKey)]);
}

async function geminiStatus(pool, userId) {
  const result = await pool.query("SELECT status,last_verified_at FROM gemini_connections WHERE user_id=$1", [userId]);
  const storedConnected = result.rows[0]?.status === 'CONNECTED';
  const devCredentialsAvailable = process.env.GEMINI_DEV_USE_ENV_KEY === 'true' && Boolean(String(process.env.GEMINI_API_KEY || '').trim());
  return {
    connected: storedConnected || devCredentialsAvailable,
    source: storedConnected ? 'stored' : devCredentialsAvailable ? 'development' : null,
    lastVerifiedAt: result.rows[0]?.last_verified_at || null,
    devCredentialsAvailable,
  };
}

async function loadGeminiApiKey(pool, userId) {
  const result = await pool.query("SELECT api_key_encrypted FROM gemini_connections WHERE user_id=$1 AND status='CONNECTED'", [userId]);
  if (result.rows[0]) return decryptSecret(result.rows[0].api_key_encrypted);
  if (process.env.GEMINI_DEV_USE_ENV_KEY === 'true' && process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  throw Object.assign(new Error('Account chưa cấu hình Gemini API.'), { statusCode: 409 });
}

module.exports = { verifyGeminiApiKey, connectGemini, geminiStatus, loadGeminiApiKey };
