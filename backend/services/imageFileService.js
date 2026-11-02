const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const temporaryImageDirectory = String(process.env.SAPI_TEMP_IMAGE_DIR || '').trim()
  ? path.resolve(process.env.SAPI_TEMP_IMAGE_DIR)
  : path.join(os.tmpdir(), 'sapi-temporary-invoice-images');
const mimeExtensions = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

function detectedMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function saveTemporaryImage(file) {
  const mimeType = detectedMime(file.buffer);
  if (!mimeType || !mimeExtensions.has(mimeType)) throw Object.assign(new Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WEBP hợp lệ.'), { statusCode: 400 });
  await fs.mkdir(temporaryImageDirectory, { recursive: true });
  const filename = `${crypto.randomBytes(24).toString('hex')}${mimeExtensions.get(mimeType)}`;
  const imagePath = path.join(temporaryImageDirectory, filename);
  await fs.writeFile(imagePath, file.buffer, { flag: 'wx' });
  return { imagePath, mimeType, fileSize: file.buffer.length };
}

async function removeTemporaryImages(paths) {
  await Promise.all(paths.map((imagePath) => fs.unlink(imagePath).catch((error) => {
    if (error.code !== 'ENOENT') console.warn('Unable to remove temporary invoice image:', error.message);
  })));
}

module.exports = { saveTemporaryImage, removeTemporaryImages, temporaryImageDirectory };
