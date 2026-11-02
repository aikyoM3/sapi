require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');
const { ensureKiotVietSchema, syncCategories, syncProducts, syncSuppliers } = require('./kiotviet');
const { extractInvoiceFromImage, GeminiInvoiceError } = require('./services/geminiInvoiceService');
const { getTestInvoiceImage, TestInvoiceImageError } = require('./services/testInvoiceImageService');
const { mapExtractedInvoice } = require('./services/invoiceMappingService');
const { runMigrations } = require('./db/migrate');
const { requireAuth, currentUserId } = require('./middleware/auth');
const createAuthRoutes = require('./routes/authRoutes');
const createDataRoutes = require('./routes/dataRoutes');
const createInvoiceSessionRoutes = require('./routes/invoiceSessionRoutes');
const createKiotVietIntegrationRoutes = require('./routes/kiotVietIntegrationRoutes');
const createGeminiIntegrationRoutes = require('./routes/geminiIntegrationRoutes');
const { loadGeminiApiKey } = require('./services/geminiConnectionService');
const { loadConnectionConfig, syncConnection } = require('./services/kiotVietConnectionService');
const { getMobileBaseUrl } = require('./services/lanAddress');
const createKiotVietMockRoutes = require('./mock/kiotVietMockRoutes');

const app = express();
const port = Number(process.env.PORT) || 3000;
const frontendDirectory = path.join(__dirname, '..', 'frontend');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const PgSession = connectPgSimple(session);
const configuredSessionSecret = String(process.env.SESSION_SECRET || '').trim();
const sessionSecret = configuredSessionSecret || crypto.randomBytes(32).toString('hex');
if (!configuredSessionSecret) console.warn('SESSION_SECRET is not configured; sessions will be invalidated when the server restarts.');

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
if (String(process.env.KIOTVIET_MODE || 'live').toLowerCase() === 'mock') app.use('/mock/kiotviet', createKiotVietMockRoutes());
app.use(session({
  store: new PgSession({ pool, tableName: 'user_session', createTableIfMissing: false }),
  name: 'sapi.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

app.use('/api/auth', createAuthRoutes(pool));
app.use(createInvoiceSessionRoutes(pool));
app.use('/api', requireAuth, createDataRoutes(pool));
app.use('/api/integrations/kiotviet', requireAuth, createKiotVietIntegrationRoutes(pool));
app.use('/api/integrations/gemini', requireAuth, createGeminiIntegrationRoutes(pool));

const invoiceImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith('image/')),
});

// Kept for compatibility with the original one-image test flow.
app.post('/api/invoices/extract', requireAuth, invoiceImageUpload.single('invoiceImage'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Ảnh hóa đơn không hợp lệ.' });
  try {
    const userId = currentUserId(req);
    const buyer = (await pool.query('SELECT store_name, tax_code, address, phone, email FROM users WHERE user_id=$1', [userId])).rows[0] || {};
    const gemini = await extractInvoiceFromImage(req.file, { apiKey: await loadGeminiApiKey(pool, userId), buyer });
    const corresponding = await mapExtractedInvoice(pool, gemini, userId);
    res.json({ gemini, corresponding });
  } catch (error) {
    if (error instanceof GeminiInvoiceError) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

app.get('/api/invoices/test-image', requireAuth, async (_req, res, next) => {
  try {
    const image = await getTestInvoiceImage();
    res.set({ 'Content-Type': image.mimetype, 'Cache-Control': 'no-store', 'X-Test-Image-Filename': encodeURIComponent(image.filename) });
    res.send(image.buffer);
  } catch (error) {
    if (error instanceof TestInvoiceImageError) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

async function runSync(req, res, syncFunction) {
  try {
    const userId = currentUserId(req);
    const config = await loadConnectionConfig(pool, userId);
    await ensureKiotVietSchema(pool);
    res.json(await syncFunction(pool, req.query.lastModifiedFrom, userId, config));
  } catch (error) {
    console.error('KiotViet synchronization failed:', error.message);
    res.status(error.statusCode || 502).json({ error: error.message || 'Không thể đồng bộ KiotViet.' });
  }
}

app.post('/api/kiotviet/sync/categories', requireAuth, (req, res) => runSync(req, res, syncCategories));
app.post('/api/kiotviet/sync/products', requireAuth, (req, res) => runSync(req, res, syncProducts));
app.post('/api/kiotviet/sync/suppliers', requireAuth, (req, res) => runSync(req, res, syncSuppliers));
app.post('/api/kiotviet/sync/all', requireAuth, async (req, res) => {
  try {
    res.json(await syncConnection(pool, currentUserId(req), req.query.lastModifiedFrom));
  } catch (error) {
    console.error('KiotViet synchronization failed:', error.message);
    res.status(error.statusCode || 502).json({ error: error.message || 'Không thể đồng bộ KiotViet.' });
  }
});

app.get('/login.html', (_req, res) => res.sendFile(path.join(frontendDirectory, 'login.html')));
app.get('/register.html', (_req, res) => res.sendFile(path.join(frontendDirectory, 'register.html')));
app.get('/invoice-session/:token/upload', (_req, res) => res.sendFile(path.join(frontendDirectory, 'mobile-upload.html')));
app.get('/huong-dan-ket-noi-kiotviet', requireAuth, (_req, res) => res.sendFile(path.join(frontendDirectory, 'kiotviet-guide.html')));
app.get('/huong-dan-ket-noi-gemini', requireAuth, (_req, res) => res.sendFile(path.join(frontendDirectory, 'gemini-guide.html')));
app.get('/', requireAuth, (_req, res) => res.sendFile(path.join(frontendDirectory, 'index.html')));
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path.endsWith('.html') || req.path === '/app.js')) return requireAuth(req, res, next);
  next();
});
app.use(express.static(frontendDirectory, { index: false }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint không tồn tại.' });
  res.status(404).send('Không tìm thấy trang.');
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'Mỗi ảnh phải nhỏ hơn hoặc bằng 10 MB.' : 'Không thể upload tập ảnh này.';
    return res.status(400).json({ error: message });
  }
  const statusCode = Number(error.statusCode) || (error.code === '23505' ? 409 : 500);
  if (statusCode >= 500) console.error('Server error:', error);
  res.status(statusCode).json({ error: statusCode >= 500 ? 'Đã có lỗi máy chủ. Vui lòng thử lại.' : error.message });
});

async function start() {
  await runMigrations(pool);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Project I is running on port ${port}`);
    try { console.log(`Mobile base URL: ${getMobileBaseUrl({ port })}`); }
    catch (error) { console.warn(error.message); }
  });
}

start().catch((error) => {
  console.error('Unable to start Project I:', error);
  process.exitCode = 1;
});

module.exports = { app, pool, start };
