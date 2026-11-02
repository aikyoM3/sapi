const crypto = require('crypto');

function encryptionKey() {
  const configured = String(process.env.INTEGRATION_ENCRYPTION_KEY || '').trim();
  let key;
  if (/^[0-9a-f]{64}$/i.test(configured)) key = Buffer.from(configured, 'hex');
  else key = Buffer.from(configured, 'base64');
  if (key.length !== 32) throw Object.assign(new Error('INTEGRATION_ENCRYPTION_KEY phải là 32 byte dạng base64 hoặc 64 ký tự hex.'), { statusCode: 503 });
  return key;
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSecret(value) {
  const [version, iv, tag, encrypted] = String(value || '').split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('KiotViet Client Secret đã lưu không hợp lệ.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
