const { GoogleGenAI } = require('@google/genai');
const { invoiceExtractionPrompt } = require('./geminiInvoicePrompt');

// This is the application's standardized Gemini response. Do not rename fields without a migration.
const invoiceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplier: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: ['string', 'null'] },
        phone: { type: ['string', 'null'] },
        address: { type: ['string', 'null'] },
        tax_code: { type: ['string', 'null'] },
      },
      required: ['name', 'phone', 'address', 'tax_code'],
    },
    invoice: {
      type: 'object',
      additionalProperties: false,
      properties: {
        number: { type: ['string', 'null'] },
        date: { type: ['string', 'null'], description: 'Use YYYY-MM-DD only when the date is clearly readable.' },
      },
      required: ['number', 'date'],
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: ['string', 'null'] },
          quantity: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'] },
          unit_price: { type: ['number', 'null'] },
          total_price: { type: ['number', 'null'] },
        },
        required: ['name', 'quantity', 'unit', 'unit_price', 'total_price'],
      },
    },
    total_amount: { type: ['number', 'null'] },
  },
  required: ['supplier', 'invoice', 'items', 'total_amount'],
};

class GeminiInvoiceError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'GeminiInvoiceError';
    this.statusCode = statusCode;
  }
}

function config(apiKeyOverride) {
  const apiKey = String(apiKeyOverride || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new GeminiInvoiceError('Gemini chưa được cấu hình. Hãy đặt GEMINI_API_KEY trong backend/.env rồi restart server (Ctrl+C, npm.cmd start).', 503);
  }
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 120000);
  return {
    apiKey,
    model: String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
  };
}

function redactSecrets(text) {
  return String(text || '')
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, '[redacted]')
    .replace(/(api[_-]?key|key)=([^&\s]+)/gi, '$1=[redacted]');
}

function mapSdkError(error) {
  const status = Number(error?.status || error?.statusCode);
  const detail = redactSecrets(error?.message || '').slice(0, 300);
  const aborted = /aborted/i.test(detail);
  if (error?.name === 'RequestTimeoutError' || error?.name === 'AbortError' || aborted || status === 408 || status === 504) {
    return new GeminiInvoiceError('Gemini hết thời gian chờ (request bị abort). Tăng GEMINI_TIMEOUT_MS trong backend/.env (ví dụ 120000), restart server, rồi thử lại. Ảnh hóa đơn thường cần hơn 30 giây.', 504);
  }
  if (status === 401 || status === 403) {
    return new GeminiInvoiceError(status === 401 ? 'Gemini API Key không hợp lệ. Hãy kiểm tra lại API Key hoặc tạo key mới.' : 'API Key đã được nhận nhưng không thể sử dụng model Gemini hiện tại. Hãy kiểm tra quyền API hoặc cấu hình model.', 503);
  }
  if (status === 404) {
    return new GeminiInvoiceError('Model Gemini không tồn tại hoặc key không dùng được model này. Đổi GEMINI_MODEL (ví dụ gemini-2.0-flash) trong backend/.env rồi restart server.', 502);
  }
  if (status === 429) {
    return new GeminiInvoiceError('Gemini API hiện đã đạt giới hạn sử dụng. Vui lòng thử lại sau hoặc kiểm tra quota của API Key.', 429);
  }
  if (status === 400) {
    return new GeminiInvoiceError(`Gemini từ chối request (ảnh, schema hoặc model). ${detail || 'Xem log terminal backend.'}`, 502);
  }
  if (detail) {
    return new GeminiInvoiceError(`Gemini không đọc được hóa đơn này. ${detail}`, 502);
  }
  return new GeminiInvoiceError('Gemini không đọc được hóa đơn này. Xem log terminal backend (dòng Gemini invoice extraction failed) và mục Troubleshooting trong README.md.', 502);
}

function nullableString(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new GeminiInvoiceError(`Gemini trả về giá trị ${field} không hợp lệ.`);
  return value;
}

function nullableNumber(value, field) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new GeminiInvoiceError(`Gemini trả về giá trị ${field} không hợp lệ.`);
  return value;
}

function validateInvoice(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.supplier || !payload.invoice || !Array.isArray(payload.items)) {
    throw new GeminiInvoiceError('Gemini trả về hóa đơn không đúng schema.');
  }
  return {
    supplier: {
      name: nullableString(payload.supplier.name, 'supplier.name'),
      phone: nullableString(payload.supplier.phone, 'supplier.phone'),
      address: nullableString(payload.supplier.address, 'supplier.address'),
      tax_code: nullableString(payload.supplier.tax_code, 'supplier.tax_code'),
    },
    invoice: {
      number: nullableString(payload.invoice.number, 'invoice.number'),
      date: nullableString(payload.invoice.date, 'invoice.date'),
    },
    items: payload.items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new GeminiInvoiceError(`Gemini trả về dòng hàng không hợp lệ ở vị trí ${index + 1}.`);
      }
      return {
        name: nullableString(item.name, `items[${index}].name`),
        quantity: nullableNumber(item.quantity, `items[${index}].quantity`),
        unit: nullableString(item.unit, `items[${index}].unit`),
        unit_price: nullableNumber(item.unit_price, `items[${index}].unit_price`),
        total_price: nullableNumber(item.total_price, `items[${index}].total_price`),
      };
    }),
    total_amount: nullableNumber(payload.total_amount, 'total_amount'),
  };
}

function buildBuyerContext(buyer = {}) {
  const fields = [
    ['Tên', buyer.store_name],
    ['Mã số thuế', buyer.tax_code],
    ['Địa chỉ', buyer.address],
    ['Số điện thoại', buyer.phone],
    ['Email', buyer.email],
  ].filter(([, value]) => String(value || '').trim());
  if (!fields.length) return '';
  return `THÔNG TIN NGƯỜI MUA / CỬA HÀNG ĐANG SỬ DỤNG HỆ THỐNG:\n\n${fields.map(([label, value]) => `${label}: ${String(value).trim()}`).join('\n')}\n\nCác thông tin trên thuộc NGƯỜI MUA. Không dùng chúng làm nhà cung cấp/người bán. Chỉ trích xuất nhà cung cấp khi tài liệu thể hiện rõ bên bán; nếu không xác định được thì để các trường supplier là null. Không tự suy đoán nhà cung cấp từ người mua.`;
}

function normalizedStrongIdentifier(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function removeBuyerFromSupplier(invoice, buyer = {}) {
  const supplier = invoice?.supplier;
  if (!supplier) return invoice;
  const sameTaxCode = normalizedStrongIdentifier(supplier.tax_code)
    && normalizedStrongIdentifier(supplier.tax_code) === normalizedStrongIdentifier(buyer.tax_code);
  const samePhone = normalizedStrongIdentifier(supplier.phone)
    && normalizedStrongIdentifier(supplier.phone) === normalizedStrongIdentifier(buyer.phone);
  if (sameTaxCode || samePhone) invoice.supplier = { name: null, phone: null, address: null, tax_code: null };
  return invoice;
}

async function extractInvoiceFromImages(files, options = {}) {
  if (!Array.isArray(files) || !files.length || files.some((file) => !file?.buffer || !file?.mimetype)) {
    throw new GeminiInvoiceError('Cần có ít nhất một ảnh hóa đơn.', 400);
  }

  const { apiKey, model, timeoutMs } = config(options.apiKey);
  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [
        { text: `Có ${files.length} ảnh theo đúng thứ tự trang của CÙNG MỘT hóa đơn. Hãy gộp tất cả các trang thành một JSON duy nhất.` },
        ...files.map((file) => ({ inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') } })),
        ...(buildBuyerContext(options.buyer) ? [{ text: buildBuyerContext(options.buyer) }] : []),
        { text: invoiceExtractionPrompt },
      ] }],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseJsonSchema: invoiceSchema,
        httpOptions: { timeout: timeoutMs },
      },
    });

    if (!response.text) throw new GeminiInvoiceError('Gemini trả về response rỗng. Thử lại, hoặc đổi GEMINI_MODEL rồi restart server.');
    return removeBuyerFromSupplier(validateInvoice(JSON.parse(response.text)), options.buyer);
  } catch (error) {
    if (error instanceof GeminiInvoiceError) throw error;
    if (error instanceof SyntaxError) throw new GeminiInvoiceError('Gemini trả về JSON không hợp lệ (không đúng schema). Không dùng dữ liệu bịa; hãy thử lại hoặc kiểm tra prompt.');
    console.error('Gemini invoice extraction failed:', error?.status || error?.statusCode, redactSecrets(error?.message));
    throw mapSdkError(error);
  }
}

async function extractInvoiceFromImage(file, options = {}) {
  return extractInvoiceFromImages([file], options);
}

module.exports = { extractInvoiceFromImage, extractInvoiceFromImages, GeminiInvoiceError, invoiceSchema, buildBuyerContext, removeBuyerFromSupplier };
