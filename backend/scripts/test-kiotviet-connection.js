require('dotenv').config();

const TOKEN_URL = 'https://id.kiotviet.vn/connect/token';
const API_URL = 'https://public.kiotapi.com';
const TIMEOUT_MS = 15_000;

function printFailure(step, details) {
  console.log(`\n${step}:\nFAILED`);
  if (details.httpStatus) console.log(`\nHTTP:\n${details.httpStatus}`);
  console.log(`\nReason:\n${details.reason}`);
  console.log(`\nPossible cause:\n${details.cause}`);
  console.log(`\nFAILED AT:\nscripts/test-kiotviet-connection.js\nfunction:${details.functionName}()`);
  process.exitCode = 1;
}

async function request(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw Object.assign(new Error(timeout ? 'KiotViet API unavailable (timeout)' : 'KiotViet API unavailable'), {
      code: timeout ? 'TIMEOUT' : 'NETWORK',
    });
  }
}

async function getToken(clientId, clientSecret) {
  const body = new URLSearchParams({
    scopes: 'PublicApi.Access',
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw Object.assign(new Error(payload.error || payload.error_description || 'OAuth authentication failed'), {
      httpStatus: response.status,
      code: 'OAUTH',
    });
  }
  return { token: payload.access_token, expiresIn: payload.expires_in };
}

async function verifyRetailer(token, retailer) {
  const url = new URL('/branches', API_URL);
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('currentItem', '0');
  const response = await request(url, {
    headers: { Authorization: `Bearer ${token}`, Retailer: retailer },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiMessage = payload.message || payload.error || `HTTP ${response.status}`;
    throw Object.assign(new Error(apiMessage), { httpStatus: response.status, code: response.status === 402 ? 'ACCOUNT_EXPIRED' : 'RETAILER' });
  }
  return payload;
}

async function main() {
  console.log('=== KIOTVIET CONNECTION TEST ===');
  const clientId = String(process.env.KIOTVIET_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.KIOTVIET_CLIENT_SECRET || '').trim();
  const retailer = String(process.env.KIOTVIET_RETAILER || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\.kiotviet\.vn$/, '');

  if (!clientId || !clientSecret || !retailer) {
    printFailure('Configuration', {
      reason: 'Thiếu KIOTVIET_CLIENT_ID, KIOTVIET_CLIENT_SECRET hoặc KIOTVIET_RETAILER trong .env',
      cause: '- kiểm tra file backend/.env', functionName: 'main',
    });
    return;
  }

  let auth;
  try {
    auth = await getToken(clientId, clientSecret);
  } catch (error) {
    printFailure('OAuth', {
      httpStatus: error.httpStatus,
      reason: error.code === 'OAUTH' ? 'OAuth authentication failed' : error.message,
      cause: error.code === 'OAUTH' ? '- sai Client ID\n- sai Client Secret' : '- timeout hoặc không thể kết nối id.kiotviet.vn',
      functionName: 'getToken',
    });
    return;
  }

  console.log('\nOAuth:\nSUCCESS');
  console.log('\nToken:\nRECEIVED');
  console.log(`token exists = ${Boolean(auth.token)}`);
  console.log(`length = ${auth.token.length}`);
  console.log(`Expires:\n${auth.expiresIn ?? 'Không có trong response'}`);
  console.log(`\nRetailer:\n${retailer}`);

  try {
    const payload = await verifyRetailer(auth.token, retailer);
    const branches = Array.isArray(payload.data) ? payload.data : [];
    const firstBranch = branches[0] || {};
    console.log('\nVerify API:\nSUCCESS');
    console.log(`\nResponse:\ntotal = ${payload.total ?? branches.length}\nbranches received = ${branches.length}`);
    if (branches.length) console.log(`branch fields = ${Object.keys(firstBranch).join(', ')}`);
    const branchName = firstBranch.branchName || firstBranch.name;
    if (branchName) console.log(`\nBranch:\n${branchName}`);
    console.log('\nConnection:\nREADY');
  } catch (error) {
    printFailure('Verify retailer', {
      httpStatus: error.httpStatus,
      reason: ['RETAILER', 'ACCOUNT_EXPIRED'].includes(error.code) ? 'Token OK - Retailer verification failed' : error.message,
      cause: error.code === 'ACCOUNT_EXPIRED' ? '- gian hàng development có thể đã hết hạn\n- dịch vụ API không còn hiệu lực' : error.code === 'RETAILER' ? '- sai KIOTVIET_RETAILER\n- tài khoản API không có quyền truy cập gian hàng' : '- timeout hoặc KiotViet Public API không khả dụng',
      functionName: 'verifyRetailer',
    });
  }
}

main().catch((error) => {
  printFailure('Code', { reason: error.message, cause: '- lỗi không mong đợi trong script', functionName: 'main' });
});
