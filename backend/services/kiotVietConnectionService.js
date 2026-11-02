const { encryptSecret, decryptSecret } = require('./integrationEncryption');
const { verifyKiotViet, syncAll, KiotVietError } = require('../kiotviet');

function normalizeRetailer(value) {
  let retailer = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  retailer = retailer.replace(/\.kiotviet\.vn$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,254}$/.test(retailer)) throw Object.assign(new Error('Gian hàng KiotViet không hợp lệ.'), { statusCode: 400 });
  return retailer;
}

function credentialsFromRequest(body) {
  if (body.useDevCredentials === true) {
    if (process.env.KIOTVIET_DEV_USE_ENV_CREDENTIALS !== 'true') throw Object.assign(new Error('Chức năng dùng credential development chưa được bật.'), { statusCode: 403 });
    return {
      clientId: String(process.env.KIOTVIET_CLIENT_ID || '').trim(),
      clientSecret: String(process.env.KIOTVIET_CLIENT_SECRET || '').trim(),
      retailer: String(process.env.KIOTVIET_RETAILER || '').trim(),
    };
  }
  return {
    clientId: String(body.clientId || '').trim(),
    clientSecret: String(body.clientSecret || '').trim(),
    retailer: String(body.retailer || '').trim(),
  };
}

async function connectKiotViet(pool, userId, body) {
  const credentials = credentialsFromRequest(body);
  if (body.useDevCredentials !== true && (!credentials.clientId || !credentials.clientSecret || !credentials.retailer)) {
    const existing = (await pool.query('SELECT client_id,client_secret_encrypted,retailer_code FROM kiotviet_connections WHERE user_id=$1', [userId])).rows[0];
    if (existing) {
      credentials.clientId ||= existing.client_id;
      credentials.clientSecret ||= decryptSecret(existing.client_secret_encrypted);
      credentials.retailer ||= existing.retailer_code;
    }
  }
  if (!credentials.clientId || !credentials.clientSecret || !credentials.retailer) throw new KiotVietError('Thiếu thông tin kết nối KiotViet.\nVui lòng kiểm tra Client ID, Mã bảo mật và gian hàng.', 'VALIDATION', 400);
  credentials.retailer = normalizeRetailer(credentials.retailer);
  const verified = await verifyKiotViet(credentials);
  const encryptedSecret = encryptSecret(credentials.clientSecret);
  const { rows } = await pool.query(`
    INSERT INTO kiotviet_connections
      (user_id, retailer_code, retailer_name, client_id, client_secret_encrypted, status, connected_at, last_verified_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,'CONNECTED',NOW(),NOW(),NOW())
    ON CONFLICT (user_id) DO UPDATE SET retailer_code=EXCLUDED.retailer_code,
      retailer_name=EXCLUDED.retailer_name, client_id=EXCLUDED.client_id,
      client_secret_encrypted=EXCLUDED.client_secret_encrypted, status='CONNECTED',
      connected_at=NOW(), last_verified_at=NOW(), updated_at=NOW()
    RETURNING retailer_code, retailer_name, last_sync_at
  `, [userId, verified.retailerCode, verified.retailerName, credentials.clientId, encryptedSecret]);
  return rows[0];
}

async function loadConnectionConfig(pool, userId) {
  const { rows } = await pool.query(`
    SELECT retailer_code, client_id, client_secret_encrypted
    FROM kiotviet_connections WHERE user_id=$1 AND status='CONNECTED'
  `, [userId]);
  if (!rows[0]) throw new KiotVietError('Chưa có kết nối KiotViet.\n\nHãy cấu hình KiotViet trong mục Sửa thông tin trước khi đồng bộ.', 'NOT_CONNECTED', 409);
  return { retailer: rows[0].retailer_code, clientId: rows[0].client_id, clientSecret: decryptSecret(rows[0].client_secret_encrypted) };
}

async function checkConnection(pool, userId) {
  const result = await verifyKiotViet(await loadConnectionConfig(pool, userId));
  await pool.query("UPDATE kiotviet_connections SET retailer_name=$1,last_verified_at=NOW(),status='CONNECTED',updated_at=NOW() WHERE user_id=$2", [result.retailerName, userId]);
  return result;
}

async function connectionStatus(pool, userId) {
  const { rows } = await pool.query(`
    SELECT retailer_code, retailer_name, status, connected_at, last_verified_at, last_sync_at
    FROM kiotviet_connections WHERE user_id=$1
  `, [userId]);
  const connection = rows[0];
  return {
    mode: String(process.env.KIOTVIET_MODE || 'live').toLowerCase(),
    connected: connection?.status === 'CONNECTED',
    retailerCode: connection?.retailer_code || null,
    retailerName: connection?.retailer_name || null,
    connectedAt: connection?.connected_at || null,
    lastVerifiedAt: connection?.last_verified_at || null,
    lastSyncAt: connection?.last_sync_at || null,
    devCredentialsAvailable: process.env.KIOTVIET_DEV_USE_ENV_CREDENTIALS === 'true',
  };
}

async function syncConnection(pool, userId, lastModifiedFrom) {
  const credentials = await loadConnectionConfig(pool, userId);
  try {
    const result = await syncAll(pool, userId, credentials, lastModifiedFrom);
    await pool.query("UPDATE kiotviet_connections SET last_sync_at=NOW(), status='CONNECTED', updated_at=NOW() WHERE user_id=$1", [userId]);
    return result;
  } catch (error) {
    await pool.query("UPDATE kiotviet_connections SET updated_at=NOW() WHERE user_id=$1", [userId]).catch(() => {});
    throw error;
  }
}

async function disconnectKiotViet(pool, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM kiotvietbranch WHERE user_id=$1', [userId]);
    await client.query('DELETE FROM kiotviet_connections WHERE user_id=$1', [userId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

module.exports = { normalizeRetailer, connectKiotViet, loadConnectionConfig, connectionStatus, syncConnection, disconnectKiotViet, checkConnection };
