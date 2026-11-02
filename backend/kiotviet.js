const LIVE_TOKEN_URL = 'https://id.kiotviet.vn/connect/token';
const LIVE_API_URL = 'https://public.kiotapi.com';
const PAGE_SIZE = 100;

class KiotVietError extends Error {
  constructor(message, code, statusCode = 502) {
    super(message); this.name = 'KiotVietError'; this.code = code; this.statusCode = statusCode;
  }
}

function getKiotVietEndpoints() {
  const mode = String(process.env.KIOTVIET_MODE || 'live').trim().toLowerCase();
  if (!['live', 'mock'].includes(mode)) throw new KiotVietError('KIOTVIET_MODE chỉ nhận live hoặc mock.', 'VALIDATION', 500);
  if (mode === 'live') return { mode, tokenUrl: LIVE_TOKEN_URL, apiUrl: LIVE_API_URL };
  const mockBaseUrl = String(process.env.KIOTVIET_MOCK_BASE_URL || `http://127.0.0.1:${Number(process.env.PORT) || 3000}/mock/kiotviet`).replace(/\/$/, '');
  return { mode, tokenUrl: `${mockBaseUrl}/connect/token`, apiUrl: mockBaseUrl };
}

const requestSignal = () => AbortSignal.timeout(Number(process.env.KIOTVIET_TIMEOUT_MS) || 15000);
function connectionError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return new KiotVietError('Không nhận được phản hồi từ KiotViet.\n\nHãy kiểm tra kết nối mạng và thử lại.', 'TIMEOUT', 504);
  return new KiotVietError('Không nhận được phản hồi từ KiotViet.\n\nHãy kiểm tra kết nối mạng và thử lại.', 'NETWORK', 502);
}
function apiStatusError(status) {
  if (status === 402) return new KiotVietError('Gian hàng KiotViet hiện không thể sử dụng API.\n\nTài khoản có thể đã hết hạn, bị khóa hoặc không còn quyền truy cập.', 'ACCOUNT_UNAVAILABLE', 402);
  if (status === 403) return new KiotVietError('Kết nối KiotViet chưa được cấp quyền sử dụng API.\n\nHãy kiểm tra phần Kết nối API trong KiotViet.', 'PERMISSION', 403);
  if ([401, 404].includes(status)) return new KiotVietError('Không thể truy cập gian hàng KiotViet.\n\nHãy kiểm tra lại mã hoặc địa chỉ gian hàng và quyền truy cập API.', 'RETAILER', 400);
  if (status >= 500) return new KiotVietError('KiotViet đang tạm thời không thể xử lý yêu cầu.\n\nVui lòng thử lại sau.', 'SERVER', 502);
  return new KiotVietError('Không thể truy cập gian hàng KiotViet.\n\nHãy kiểm tra lại mã hoặc địa chỉ gian hàng và quyền truy cập API.', 'RETAILER', 400);
}

function validatedConfig(config) {
  const result = {
    clientId: String(config?.clientId || '').trim(),
    clientSecret: String(config?.clientSecret || '').trim(),
    retailer: String(config?.retailer || '').trim().toLowerCase(),
  };
  if (!result.clientId || !result.clientSecret || !result.retailer) throw new KiotVietError('Thiếu thông tin kết nối KiotViet.', 'VALIDATION', 400);
  return result;
}

async function getAccessToken(config, endpoints = getKiotVietEndpoints()) {
  const credentials = validatedConfig(config);
  const body = new URLSearchParams({ scopes: 'PublicApi.Access', grant_type: 'client_credentials', client_id: credentials.clientId, client_secret: credentials.clientSecret });
  let response;
  try {
    response = await fetch(endpoints.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: requestSignal() });
  } catch (error) {
    throw connectionError(error);
  }
  if ([400, 401, 403].includes(response.status)) throw new KiotVietError('Không thể xác thực với KiotViet.\n\nClient ID hoặc Mã bảo mật không hợp lệ.\nVui lòng kiểm tra lại thông tin API.', 'AUTH', 400);
  if (response.status >= 500) throw new KiotVietError('KiotViet đang tạm thời không thể xử lý yêu cầu.\n\nVui lòng thử lại sau.', 'SERVER', 502);
  if (!response.ok) throw connectionError();
  const payload = await response.json().catch(() => ({}));
  if (!payload.access_token) throw new KiotVietError('Client ID hoặc Mã bảo mật không hợp lệ.', 'AUTH', 400);
  return payload.access_token;
}

async function createClient(config) {
  const credentials = validatedConfig(config);
  const endpoints = getKiotVietEndpoints();
  const accessToken = await getAccessToken(credentials, endpoints);
  return {
    credentials,
    async get(apiPath, query = {}) {
      const url = new URL(`${endpoints.apiUrl}${apiPath}`);
      Object.entries(query).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value)); });
      let response;
      try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Retailer: credentials.retailer }, signal: requestSignal() });
      } catch (error) {
        throw connectionError(error);
      }
      if (!response.ok) throw apiStatusError(response.status);
      return response.json();
    },
    async post(apiPath, payload) {
      let response;
      try {
        response = await fetch(`${endpoints.apiUrl}${apiPath}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Retailer: credentials.retailer,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload), signal: requestSignal(),
        });
      } catch (error) {
        throw connectionError(error);
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok && ![400, 409, 422].includes(response.status)) throw apiStatusError(response.status);
      if (!response.ok) throw new KiotVietError(result.message || result.error || `KiotViet từ chối phiếu nhập (HTTP ${response.status}).`, 'PURCHASE_ORDER', 400);
      return result;
    },
  };
}

function buildPurchaseOrderPayload({ branchId, supplier, purchaseDate, discount, total, items, invoiceNumber }) {
  return {
    purchaseDate: purchaseDate.toISOString(),
    branchId,
    supplier: {
      ...(supplier.code ? { code: supplier.code } : {}),
      name: supplier.name,
      contactNumber: supplier.phone || '',
      address: supplier.address || '',
    },
    description: `Tạo từ SAPI${invoiceNumber ? ` - Hóa đơn ${invoiceNumber}` : ''}`,
    isDraft: 1,
    discount,
    paidAmount: total,
    paymentMethod: 'Cash',
    purchaseOrderDetails: items.map((item) => ({
      productCode: item.productCode,
      quantity: item.quantity,
      price: item.unitPrice,
    })),
  };
}

async function createPurchaseOrder(config, payload) {
  return (await createClient(config)).post('/purchaseorders', payload);
}

async function verifyKiotViet(config) {
  const client = await createClient(config);
  const payload = await client.get('/branches', { pageSize: PAGE_SIZE, currentItem: 0 });
  const branches = Array.isArray(payload.data) ? payload.data : [];
  return { retailerCode: client.credentials.retailer, retailerName: payload.retailerName || payload.retailer?.name || client.credentials.retailer, branches };
}

function validateLastModifiedFrom(value) {
  if (!value) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new KiotVietError('lastModifiedFrom không hợp lệ.', 'VALIDATION', 400);
  return value;
}

async function fetchAll(client, apiPath, lastModifiedFrom) {
  const rows = []; let currentItem = 0; let total = Infinity;
  const lastModified = validateLastModifiedFrom(lastModifiedFrom);
  while (currentItem < total) {
    const page = await client.get(apiPath, { pageSize: PAGE_SIZE, currentItem, lastModifiedFrom: lastModified });
    const data = Array.isArray(page.data) ? page.data : [];
    total = Number.isFinite(Number(page.total)) ? Number(page.total) : currentItem + data.length;
    rows.push(...data);
    if (!data.length || data.length < PAGE_SIZE) break;
    currentItem += data.length;
  }
  return rows;
}

async function ensureKiotVietSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS category (
      category_id SERIAL PRIMARY KEY, kiotviet_id BIGINT NOT NULL UNIQUE,
      category_name VARCHAR(255) NOT NULL, parent_kiotviet_id BIGINT, kiotviet_modified_at TIMESTAMPTZ
    );
    ALTER TABLE product ADD COLUMN IF NOT EXISTS kiotviet_id BIGINT;
    ALTER TABLE product ADD COLUMN IF NOT EXISTS kiotviet_category_id BIGINT;
    ALTER TABLE product ADD COLUMN IF NOT EXISTS kiotviet_modified_at TIMESTAMPTZ;
    ALTER TABLE supplier ADD COLUMN IF NOT EXISTS kiotviet_id BIGINT;
    ALTER TABLE supplier ADD COLUMN IF NOT EXISTS kiotviet_modified_at TIMESTAMPTZ;
  `);
}

async function syncBranches(pool, lastModifiedFrom, userId, config) {
  const branches = await fetchAll(await createClient(config), '/branches', lastModifiedFrom);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const branch of branches) await client.query(`
      INSERT INTO kiotvietbranch (user_id, kiotviet_id, branch_name, address, contact_number, kiotviet_modified_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (user_id, kiotviet_id) DO UPDATE SET branch_name=EXCLUDED.branch_name, address=EXCLUDED.address,
        contact_number=EXCLUDED.contact_number, kiotviet_modified_at=EXCLUDED.kiotviet_modified_at
    `, [userId, branch.id, branch.branchName || branch.name || `Branch ${branch.id}`, branch.address || null, branch.contactNumber || null, branch.modifiedDate || null]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { entity: 'branches', received: branches.length, upserted: branches.length };
}

async function syncCategories(pool, lastModifiedFrom, _userId, config) {
  const categories = await fetchAll(await createClient(config), '/categories', lastModifiedFrom);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const category of categories) await client.query(`
      INSERT INTO category (kiotviet_id, category_name, parent_kiotviet_id, kiotviet_modified_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (kiotviet_id) DO UPDATE SET category_name=EXCLUDED.category_name,
        parent_kiotviet_id=EXCLUDED.parent_kiotviet_id, kiotviet_modified_at=EXCLUDED.kiotviet_modified_at
    `, [
      category.categoryId ?? category.id,
      category.categoryName || category.name || `Category ${category.categoryId ?? category.id}`,
      category.parentId || null,
      category.modifiedDate || null,
    ]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { entity: 'categories', received: categories.length, upserted: categories.length };
}

async function syncProducts(pool, lastModifiedFrom, userId, config) {
  if (!userId) throw new KiotVietError('Cần đăng nhập để đồng bộ sản phẩm.', 'VALIDATION', 401);
  const products = await fetchAll(await createClient(config), '/products', lastModifiedFrom);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const product of products) await client.query(`
      INSERT INTO product (user_id,kiotviet_id,product_code,product_name,primary_unit,quantity,kiotviet_category_id,kiotviet_modified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (user_id,kiotviet_id) WHERE user_id IS NOT NULL AND kiotviet_id IS NOT NULL DO UPDATE SET
        product_code=EXCLUDED.product_code, product_name=EXCLUDED.product_name, primary_unit=EXCLUDED.primary_unit,
        quantity=COALESCE(EXCLUDED.quantity,product.quantity), kiotviet_category_id=EXCLUDED.kiotviet_category_id,
        kiotviet_modified_at=EXCLUDED.kiotviet_modified_at
    `, [userId, product.id, product.code || null, product.name || product.fullName || `KiotViet product ${product.id}`, product.unit || null, product.onHand ?? null, product.categoryId || null, product.modifiedDate || null]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { entity: 'products', received: products.length, upserted: products.length };
}

async function syncSuppliers(pool, lastModifiedFrom, userId, config) {
  if (!userId) throw new KiotVietError('Cần đăng nhập để đồng bộ nhà cung cấp.', 'VALIDATION', 401);
  const suppliers = await fetchAll(await createClient(config), '/suppliers', lastModifiedFrom);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const supplier of suppliers) await client.query(`
      INSERT INTO supplier (user_id,kiotviet_id,supplier_name,phone_number,address,kiotviet_modified_at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (user_id,kiotviet_id) WHERE user_id IS NOT NULL AND kiotviet_id IS NOT NULL DO UPDATE SET
        supplier_name=EXCLUDED.supplier_name, phone_number=EXCLUDED.phone_number, address=EXCLUDED.address,
        kiotviet_modified_at=EXCLUDED.kiotviet_modified_at
    `, [userId, supplier.id, supplier.name || `KiotViet supplier ${supplier.id}`, supplier.contactNumber || null, supplier.address || null, supplier.modifiedDate || null]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { entity: 'suppliers', received: suppliers.length, upserted: suppliers.length };
}

async function syncAll(pool, userId, config, lastModifiedFrom) {
  await ensureKiotVietSchema(pool);
  return {
    branches: await syncBranches(pool, lastModifiedFrom, userId, config),
    categories: await syncCategories(pool, lastModifiedFrom, userId, config),
    suppliers: await syncSuppliers(pool, lastModifiedFrom, userId, config),
    products: await syncProducts(pool, lastModifiedFrom, userId, config),
  };
}

module.exports = { KiotVietError, getKiotVietEndpoints, verifyKiotViet, buildPurchaseOrderPayload, createPurchaseOrder, ensureKiotVietSchema, syncBranches, syncCategories, syncProducts, syncSuppliers, syncAll };
