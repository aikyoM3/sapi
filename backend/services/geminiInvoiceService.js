const { createGeminiClient, getGeminiEndpointSettings, redactGeminiSecrets } = require('./geminiClient');
const { invoiceExtractionPrompt, getInvoicePrompt, getInvoicePromptPlan } = require('./geminiInvoicePrompt');

const LAYOUT_TYPES = ['SINGLE_UNIT_COLUMN', 'SPLIT_QUANTITY_COLUMNS', 'FREE_FORM', 'UNKNOWN'];
const DOCUMENT_TYPES = ['PRINTED', 'HANDWRITTEN', 'MIXED', 'UNKNOWN'];
const LEGIBILITY_LEVELS = ['CLEAR', 'PARTIAL', 'UNREADABLE'];

// This is the application's standardized Gemini response. Do not rename fields without a migration.
const invoiceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    document_type: {
      type: 'string', enum: DOCUMENT_TYPES,
      description: 'Whether transaction content is printed, handwritten, mixed, or uncertain.',
    },
    legibility: {
      type: 'string', enum: LEGIBILITY_LEVELS,
      description: 'Overall confidence that the visible writing can be read without guessing.',
    },
    layout_type: {
      type: 'string',
      enum: ['SINGLE_UNIT_COLUMN', 'SPLIT_QUANTITY_COLUMNS', 'FREE_FORM', 'UNKNOWN'],
      description: 'Overall quantity/unit table layout visible in the document.',
    },
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
          raw_unit_column: { type: ['string', 'null'], description: 'Value from a dedicated DVT/unit cell, or null when units are quantity sub-headers.' },
          quantity_cells: {
            type: 'array',
            description: 'Every visible quantity sub-column for this line, preserving empty cells as null.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sub_header: { type: ['string', 'null'] },
                value: { type: ['number', 'null'] },
              },
              required: ['sub_header', 'value'],
            },
          },
          quantity: { type: ['number', 'null'], description: 'Quantity printed for this line; do not multiply it by the package factor.' },
          unit: { type: ['string', 'null'], description: 'Unit from the label/header aligned with the exact quantity cell; never substitute an adjacent column or price unit.' },
          package_quantity: { type: ['number', 'null'], description: 'Explicit packaging/conversion factor recognized from document labels and layout; null when absent or uncertain.' },
          package_unit: { type: ['string', 'null'], description: 'Explicit child/package unit associated with the packaging factor; null when absent or uncertain.' },
          unit_price: { type: ['number', 'null'], description: 'Price printed for the line; do not convert it to force quantity multiplied by price.' },
          price_unit: { type: ['string', 'null'], description: 'Unit to which unit_price explicitly applies; null when not shown clearly.' },
          total_price: { type: ['number', 'null'], description: 'Printed line total. It may include an explicit package factor; preserve it instead of recalculating.' },
          line_type: { type: 'string', enum: ['PRODUCT', 'PROMOTION_ITEM'] },
          line_status: { type: 'string', enum: ['ACTIVE', 'CANCELLED', 'UNCERTAIN'] },
          status_reason: { type: ['string', 'null'] },
        },
        required: ['name', 'raw_unit_column', 'quantity_cells', 'quantity', 'unit', 'package_quantity', 'package_unit', 'unit_price', 'price_unit', 'total_price', 'line_type', 'line_status', 'status_reason'],
      },
    },
    promotions: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { description: { type: ['string', 'null'] }, amount: { type: ['number', 'null'] } },
      required: ['description', 'amount'] } },
    total_amount: { type: ['number', 'null'] },
  },
  required: ['document_type', 'legibility', 'layout_type', 'supplier', 'invoice', 'items', 'promotions', 'total_amount'],
};

class GeminiInvoiceError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'GeminiInvoiceError';
    this.statusCode = statusCode;
  }
}

function getExtractionSettings(connection = {}) {
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 120000);
  const temperature = Number(process.env.GEMINI_TEMPERATURE ?? 0);
  const promptPlan = getInvoicePromptPlan();
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new GeminiInvoiceError('GEMINI_TEMPERATURE phải nằm trong khoảng 0 đến 2.', 503);
  return {
    temperature,
    ...getGeminiEndpointSettings(connection.baseUrl),
    providerFallbacks: (connection.fallbackConnections || []).map((item) => getGeminiEndpointSettings(item.baseUrl)),
    model: String(process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim(),
    fallbackModel: String(process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash').trim(),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
    promptVersion: promptPlan[0].version,
    promptFallbackVersion: promptPlan[1]?.version || null,
  };
}

function config(apiKeyOverride, connection) {
  const apiKey = String(apiKeyOverride || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new GeminiInvoiceError('Gemini chưa được cấu hình. Hãy đặt GEMINI_API_KEY trong backend/.env rồi restart server (Ctrl+C, npm.cmd start).', 503);
  }
  const candidates = [{ apiKey, ...getGeminiEndpointSettings(connection?.baseUrl) }, ...(connection?.fallbackConnections || []).map((item) => ({
    apiKey: String(item.apiKey || '').trim(), ...getGeminiEndpointSettings(item.baseUrl),
  }))];
  const providers = candidates.filter((item, index) => item.apiKey && !candidates.slice(0, index).some((prior) => prior.apiKey === item.apiKey && prior.baseUrl === item.baseUrl));
  return { providers, ...getExtractionSettings(connection) };
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// A provider-side deadline (504) is not helped by immediately resubmitting the
// same, often image-heavy, request. Retry short-lived capacity errors only.
const retryableGeminiError = (error) => [429, 500, 502, 503].includes(Number(error?.status || error?.statusCode));
const MAX_ATTEMPTS_PER_MODEL = 2;

async function generateWithRetry(ai, models, request, attempts, provider, promptVersion, maxAttempts = MAX_ATTEMPTS_PER_MODEL) {
  let lastError;
  for (const model of [...new Set(models.filter(Boolean))]) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        const response = await ai.models.generateContent({ model, ...request });
        attempts.push({ provider: provider.provider, base_url: provider.baseUrl, prompt_version: promptVersion, model, attempt: attempt + 1, elapsed_ms: Date.now() - started, status: 'success' });
        return { response, model };
      }
      catch (error) {
        attempts.push({ provider: provider.provider, base_url: provider.baseUrl, prompt_version: promptVersion, model, attempt: attempt + 1, elapsed_ms: Date.now() - started, status: 'error', http_status: Number(error?.status || error?.statusCode) || null, error: redactSecrets(error?.message, provider.apiKey) });
        lastError = error;
        if (!retryableGeminiError(error) || attempt === maxAttempts - 1) break;
        await wait(1000 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

function providerFailoverError(error) {
  const status = Number(error?.status || error?.statusCode);
  return [401, 402, 403, 404, 408, 429, 500, 502, 503, 504].includes(status)
    || (status === 400 && /API_KEY_INVALID|API key not valid|invalid api.?key/i.test(error?.message || ''))
    || ['AbortError', 'RequestTimeoutError'].includes(error?.name)
    || /abort|timeout|timed out|fetch failed/i.test(error?.message || '');
}

async function generateAcrossProviders(providers, models, request, attempts, promptVersion, timeoutMs, maxAttempts) {
  let lastError;
  for (const provider of providers) {
    const ai = createGeminiClient(provider.apiKey, { timeoutMs, baseUrl: provider.baseUrl });
    try {
      const generated = await generateWithRetry(ai, models, request, attempts, provider, promptVersion, maxAttempts);
      return { ...generated, provider };
    } catch (error) {
      lastError = error;
      if (!providerFailoverError(error)) break;
    }
  }
  throw lastError;
}

function redactSecrets(text, apiKeys) {
  return (Array.isArray(apiKeys) ? apiKeys : [apiKeys]).reduce((value, apiKey) => redactGeminiSecrets(value, apiKey), String(text || ''));
}

function mapSdkError(error) {
  const status = Number(error?.status || error?.statusCode);
  const detail = redactSecrets(error?.message || '').slice(0, 300);
  const aborted = /aborted/i.test(detail);
  if (status === 504) {
    return new GeminiInvoiceError('Gemini không hoàn tất yêu cầu trước deadline của nhà cung cấp. Đây không phải lỗi ảnh hay API key; hãy thử lại sau.', 504);
  }
  if (error?.name === 'RequestTimeoutError' || error?.name === 'AbortError' || aborted || status === 408) {
    return new GeminiInvoiceError('Kết nối tới Gemini hết thời gian chờ. Hãy kiểm tra mạng rồi thử lại.', 504);
  }
  if (status === 401 || status === 403) {
    return new GeminiInvoiceError(status === 401 ? 'Gemini API Key không hợp lệ. Hãy kiểm tra lại API Key hoặc tạo key mới.' : 'API Key đã được nhận nhưng không thể sử dụng model Gemini hiện tại. Hãy kiểm tra quyền API hoặc cấu hình model.', 503);
  }
  if (status === 404) {
    return new GeminiInvoiceError('Model Gemini không tồn tại hoặc key không dùng được model này trên endpoint đã cấu hình. Kiểm tra GEMINI_MODEL và gói model của key, rồi restart server nếu đổi .env.', 502);
  }
  if (status === 402) {
    return new GeminiInvoiceError('Tài khoản API không đủ credit hoặc chưa kích hoạt thanh toán. Kiểm tra số dư tại nhà cung cấp API đang dùng.', 402);
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
    document_type: DOCUMENT_TYPES.includes(payload.document_type) ? payload.document_type : 'UNKNOWN',
    legibility: LEGIBILITY_LEVELS.includes(payload.legibility) ? payload.legibility : 'PARTIAL',
    layout_type: LAYOUT_TYPES.includes(payload.layout_type) ? payload.layout_type : 'UNKNOWN',
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
        raw_unit_column: nullableString(item.raw_unit_column ?? null, `items[${index}].raw_unit_column`),
        quantity_cells: (Array.isArray(item.quantity_cells) ? item.quantity_cells : []).map((cell, cellIndex) => ({
          sub_header: nullableString(cell?.sub_header ?? null, `items[${index}].quantity_cells[${cellIndex}].sub_header`),
          value: nullableNumber(cell?.value ?? null, `items[${index}].quantity_cells[${cellIndex}].value`),
        })),
        quantity: nullableNumber(item.quantity, `items[${index}].quantity`),
        unit: nullableString(item.unit, `items[${index}].unit`),
        package_quantity: nullableNumber(item.package_quantity, `items[${index}].package_quantity`),
        package_unit: nullableString(item.package_unit, `items[${index}].package_unit`),
        unit_price: nullableNumber(item.unit_price, `items[${index}].unit_price`),
        price_unit: nullableString(item.price_unit, `items[${index}].price_unit`),
        total_price: nullableNumber(item.total_price, `items[${index}].total_price`),
        line_type: ['PRODUCT', 'PROMOTION_ITEM'].includes(item.line_type) ? item.line_type : 'PRODUCT',
        line_status: ['ACTIVE', 'CANCELLED', 'UNCERTAIN'].includes(item.line_status) ? item.line_status : 'UNCERTAIN',
        status_reason: nullableString(item.status_reason, `items[${index}].status_reason`),
      };
    }),
    promotions: (Array.isArray(payload.promotions) ? payload.promotions : []).map((promotion, index) => ({
      description: nullableString(promotion.description, `promotions[${index}].description`),
      amount: nullableNumber(promotion.amount, `promotions[${index}].amount`),
    })),
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

// Detailed results are for offline experiments. The web API keeps returning only
// the same standardized invoice as before; no matching or persistence is added.
async function extractInvoiceFromImagesDetailed(files, options = {}) {
  if (!Array.isArray(files) || !files.length || files.some((file) => !file?.buffer || !file?.mimetype)) {
    throw new GeminiInvoiceError('Cần có ít nhất một ảnh hóa đơn.', 400);
  }

  const configured = config(options.connection?.apiKey || options.apiKey, options.connection);
  let providers = configured.providers;
  let models = [configured.model, configured.fallbackModel];
  const { timeoutMs, temperature } = configured;
  const routes = providers.flatMap((provider) => [...new Set(models.filter(Boolean))].map((model) => ({ provider, model })));
  const requestedRoute = Number.isInteger(Number(options.routeIndex)) ? Math.max(0, Number(options.routeIndex)) : 0;
  const selectedRouteIndex = routes.length ? requestedRoute % routes.length : 0;
  if (options.singleRoute && routes[selectedRouteIndex]) {
    providers = [routes[selectedRouteIndex].provider];
    models = [routes[selectedRouteIndex].model];
  }
  const diagnostics = { attempts: [], route_index: selectedRouteIndex, route_count: routes.length, model_used: null, model_version: null, provider_used: null, base_url_used: null, prompt_used: null, prompt_failures: [], raw_text: null, raw_json: null };
  try {
    const commonParts = [
      { text: `Có ${files.length} ảnh theo đúng thứ tự trang của CÙNG MỘT hóa đơn. Hãy gộp tất cả các trang thành một JSON duy nhất.` },
      ...files.map((file) => ({ inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') } })),
      ...(buildBuyerContext(options.buyer) ? [{ text: buildBuyerContext(options.buyer) }] : []),
    ];
    const promptPlan = options.promptVersion ? [getInvoicePrompt(options.promptVersion)] : getInvoicePromptPlan();
    let preferredFallbackProvider = null;
    let preferredFallbackModels = null;
    for (let promptIndex = 0; promptIndex < promptPlan.length; promptIndex += 1) {
      const prompt = promptPlan[promptIndex];
      const orderedProviders = preferredFallbackProvider
        ? [preferredFallbackProvider, ...providers.filter((item) => item.apiKey !== preferredFallbackProvider.apiKey || item.baseUrl !== preferredFallbackProvider.baseUrl)]
        : providers;
      const orderedModels = preferredFallbackModels || models;
      const generated = await generateAcrossProviders(orderedProviders, orderedModels, {
        contents: [{ role: 'user', parts: [...commonParts, { text: prompt.text }] }],
        config: { temperature, responseMimeType: 'application/json', responseJsonSchema: invoiceSchema, httpOptions: { timeout: timeoutMs } },
      }, diagnostics.attempts, prompt.version, timeoutMs, options.singleRoute ? 1 : MAX_ATTEMPTS_PER_MODEL);
      const { response } = generated;
      diagnostics.model_used = generated.model;
      diagnostics.model_version = response.modelVersion || null;
      diagnostics.provider_used = generated.provider.provider;
      diagnostics.base_url_used = generated.provider.baseUrl;
      diagnostics.prompt_used = prompt.version;
      diagnostics.raw_text = response.text || null;
      diagnostics.usage = response.usageMetadata || null;
      try {
        if (!response.text) throw new GeminiInvoiceError('Dịch vụ trích xuất trả về response rỗng.');
        diagnostics.raw_json = JSON.parse(response.text);
        const invoice = removeBuyerFromSupplier(validateInvoice(diagnostics.raw_json), options.buyer);
        return { invoice, ...diagnostics };
      } catch (error) {
        diagnostics.prompt_failures.push({ prompt_version: prompt.version, provider: generated.provider.provider, model: generated.model, error: redactSecrets(error.message, providers.map((item) => item.apiKey)) });
        if (promptIndex === promptPlan.length - 1) throw error;
        preferredFallbackProvider = generated.provider;
        preferredFallbackModels = generated.model === configured.model ? [configured.fallbackModel, configured.model] : [configured.model, configured.fallbackModel];
      }
    }
    throw new GeminiInvoiceError('Không có prompt trích xuất khả dụng.');
  } catch (error) {
    const safeError = Object.assign(new Error(redactSecrets(error?.message, providers.map((item) => item.apiKey))), { status: error?.status, statusCode: error?.statusCode, name: error?.name });
    const mapped = error instanceof GeminiInvoiceError ? error : error instanceof SyntaxError
      ? new GeminiInvoiceError('Gemini trả về JSON không hợp lệ (không đúng schema). Không dùng dữ liệu bịa; hãy thử lại hoặc kiểm tra prompt.') : mapSdkError(safeError);
    mapped.diagnostics = diagnostics;
    if (!(error instanceof GeminiInvoiceError) && !(error instanceof SyntaxError)) console.error('Gemini invoice extraction failed:', safeError.status || safeError.statusCode, safeError.message);
    throw mapped;
  }
}

async function extractInvoiceFromImages(files, options = {}) {
  return (await extractInvoiceFromImagesDetailed(files, options)).invoice;
}

async function extractInvoiceFromImage(file, options = {}) {
  return extractInvoiceFromImages([file], options);
}

module.exports = { extractInvoiceFromImage, extractInvoiceFromImages, extractInvoiceFromImagesDetailed, getExtractionSettings, GeminiInvoiceError, invoiceSchema, buildBuyerContext, removeBuyerFromSupplier };
