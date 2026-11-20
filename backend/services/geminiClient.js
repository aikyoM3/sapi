const { GoogleGenAI } = require('@google/genai');

const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com';

class GeminiConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeminiConfigurationError';
    this.statusCode = 503;
    this.code = 'GEMINI_CONFIGURATION_ERROR';
  }
}

// Validate browser-selected personal hosts against the server allowlist first.
function getGeminiEndpointSettings(baseUrlOverride) {
  const configured = String(baseUrlOverride ?? process.env.GEMINI_BASE_URL ?? '').trim();
  let url;
  try { url = new URL(configured || GOOGLE_BASE_URL); }
  catch { throw new GeminiConfigurationError('GEMINI_BASE_URL không phải URL hợp lệ.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new GeminiConfigurationError('GEMINI_BASE_URL phải là địa chỉ HTTPS gốc, không có /v1, /v1beta, query hoặc thông tin đăng nhập.');
  }
  const baseUrl = url.origin;
  const provider = baseUrl === GOOGLE_BASE_URL ? 'google' : baseUrl === 'https://api.shopaikey.com' ? 'shopaikey' : 'custom';
  return { provider, baseUrl };
}

function createGeminiClient(apiKey, { timeoutMs = 120000, baseUrl } = {}) {
  const key = String(apiKey || '').trim();
  const endpoint = getGeminiEndpointSettings(baseUrl);
  const { provider } = endpoint;
  if (!key) throw new GeminiConfigurationError('Chưa có Gemini API Key. Hãy cấu hình kết nối trước khi trích xuất.');
  // Prevent accidentally sending an account's old Google key to a new gateway,
  // or a paid gateway key to Google after removing GEMINI_BASE_URL.
  if (provider !== 'google' && key.startsWith('AIza')) {
    throw new GeminiConfigurationError('Endpoint đang dùng gateway nhưng tài khoản vẫn lưu key Google. Hãy kết nối lại bằng key của gateway.');
  }
  if (provider === 'google' && key.startsWith('sk-')) {
    throw new GeminiConfigurationError('Key gateway cần GEMINI_BASE_URL tương ứng trong backend/.env. Không gửi key này đến Google trực tiếp.');
  }
  return new GoogleGenAI({
    apiKey: key,
    vertexai: false,
    httpOptions: { baseUrl: endpoint.baseUrl, timeout: timeoutMs },
  });
}

function redactGeminiSecrets(text, apiKey) {
  const value = apiKey ? String(text || '').split(apiKey).join('[redacted]') : String(text || '');
  return value
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, '[redacted]')
    .replace(/AQ\.[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/sk-[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/(api[_-]?key|key)=([^&\s]+)/gi, '$1=[redacted]');
}

module.exports = { GOOGLE_BASE_URL, createGeminiClient, getGeminiEndpointSettings, redactGeminiSecrets, GeminiConfigurationError };
