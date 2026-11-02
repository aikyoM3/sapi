const fs = require('fs/promises');
const path = require('path');

const supportedImages = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.jfif', 'image/jpeg'],
  ['.jpe', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const testImageStem = '01';
const searchRoots = [
  path.join(__dirname, '..', '..', 'test_images'),
  path.join(__dirname, '..', 'test_images'),
];

class TestInvoiceImageError extends Error {
  constructor(message, statusCode = 404) {
    super(message);
    this.name = 'TestInvoiceImageError';
    this.statusCode = statusCode;
  }
}

function mimeFromExtension(filename) {
  return supportedImages.get(path.extname(filename).toLowerCase()) || null;
}

function mimeFromBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function readImageFile(filePath, filename) {
  const buffer = await fs.readFile(filePath);
  const mimetype = mimeFromExtension(filename) || mimeFromBuffer(buffer);
  if (!mimetype) throw new TestInvoiceImageError(`File ${filename} không phải JPG, JPEG, JFIF, PNG hoặc WEBP.`);
  return { filename, mimetype, buffer };
}

async function firstImageInDirectory(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const imageEntry = entries
    .filter((entry) => entry.isFile() && mimeFromExtension(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (!imageEntry) throw new TestInvoiceImageError('Không tìm thấy ảnh JPG, JPEG, JFIF, PNG hoặc WEBP trong test_images/01.');
  return readImageFile(path.join(directoryPath, imageEntry.name), imageEntry.name);
}

async function getTestInvoiceImage() {
  const errors = [];
  for (const testImagesRoot of searchRoots) {
    let entries;
    try {
      entries = await fs.readdir(testImagesRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    const matchingFiles = entries
      .filter((entry) => entry.isFile() && path.parse(entry.name).name.toLowerCase() === testImageStem)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (matchingFiles.length) {
      const imageFile = matchingFiles.find((entry) => mimeFromExtension(entry.name)) || matchingFiles[0];
      return readImageFile(path.join(testImagesRoot, imageFile.name), imageFile.name);
    }

    const matchingDirectory = entries.find((entry) => entry.isDirectory() && entry.name === testImageStem);
    if (matchingDirectory) {
      try {
        return await firstImageInDirectory(path.join(testImagesRoot, matchingDirectory.name));
      } catch (error) {
        if (error instanceof TestInvoiceImageError) {
          errors.push(error.message);
          continue;
        }
        throw error;
      }
    }
  }

  throw new TestInvoiceImageError(errors[0] || 'Không tìm thấy file test_images/01 (kèm extension thực tế, ví dụ .jpg/.jfif/.png) hoặc thư mục test_images/01.');
}

module.exports = { getTestInvoiceImage, TestInvoiceImageError };
