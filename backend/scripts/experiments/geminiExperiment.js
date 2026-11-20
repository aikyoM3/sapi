const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getInvoicePromptPlan } = require('../../services/geminiInvoicePrompt');
const { invoiceSchema, getExtractionSettings, buildBuyerContext } = require('../../services/geminiInvoiceService');
const backendRoot = path.resolve(__dirname, '../..');
const inputRoot = path.join(backendRoot, 'test_images');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
async function exists(file) { try { await fs.access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function mimeType(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  throw new Error('Định dạng ảnh không được luồng Gemini hiện tại hỗ trợ.');
}
async function imagesIn(folder) {
  if (!await exists(folder)) return [];
  return (await fs.readdir(folder, { withFileTypes: true })).filter((e) => e.isFile() && /\.(jpe?g|jfif|png|webp)$/i.test(e.name)).map((e) => path.join(folder, e.name)).sort((a,b) => a.localeCompare(b, 'vi', { numeric: true }));
}
async function discoverDataset() {
  const printed = await imagesIn(path.join(inputRoot, 'Giấy in'));
  const framed = await imagesIn(path.join(inputRoot, 'Điền khung'));
  const handwritten = await imagesIn(path.join(inputRoot, 'Viết tay'));
  let special = await imagesIn(path.join(inputRoot, 'Đặc biệt'));
  let relocation = null;
  if (!special.length && handwritten.some((f) => path.basename(f) === '08.jpg')) {
    special = [path.join(inputRoot, 'Viết tay', '08.jpg')];
    relocation = 'Đặc biệt/08.jpg đã chuyển sang Viết tay/08.jpg; vẫn tính vào nhóm Viết tay.';
  }
  const sets = [
    [printed, 17, 'Giấy in', 'Giấy in', 'IN'], [framed, 2, 'Điền khung', 'Điền khung', 'KH'],
    [handwritten.filter((f) => !special.includes(f)), 6, 'Viết tay', 'Viết tay', 'VT'], [special, 1, 'Viết tay', 'Đặc biệt', 'DB'],
  ];
  const images = [];
  for (const [files, expected, group, kind, prefix] of sets) {
    if (files.length !== expected) throw new Error(`${kind}: cần ${expected} ảnh, tìm thấy ${files.length}. Không tự chọn/bỏ ảnh.`);
    for (const file of files) {
      const b = await fs.readFile(file); const code = path.parse(file).name;
      images.push({ image_id: `${prefix}-${code}`, original_code: code, group, kind, source_path: path.relative(backendRoot, file).split(path.sep).join('/'), mime_type: mimeType(b), image_sha256: sha(b), file_bytes: b.length });
    }
  }
  if (images.length !== 26 || new Set(images.map((i) => i.image_id)).size !== 26) throw new Error('Cần đúng 26 mã ảnh duy nhất.');
  return { images, relocation, excluded_root_files: ['test_images/13.jpg', 'test_images/21.jpg'] };
}
function outputDirectory(name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(name)) throw new Error('--name chỉ dùng chữ/số, dấu chấm, gạch ngang hoặc gạch dưới.');
  return path.join(backendRoot, 'experiments', name);
}
async function buildManifest(dataset, account, fixture = false, connection = {}) {
  const promptPlan = getInvoicePromptPlan();
  const protocol = {
    version: 2, fixture, account: { user_id: account.user_id, username: account.username }, buyer: account.buyer,
    buyer_context: buildBuyerContext(account.buyer), settings: getExtractionSettings(connection), prompt: promptPlan[0].text,
    prompt_plan: promptPlan.map(({ version, text }) => ({ version, text })), schema: invoiceSchema,
    service_sha256: sha(await fs.readFile(path.join(backendRoot, 'services/geminiInvoiceService.js'))),
    client_sha256: sha(await fs.readFile(path.join(backendRoot, 'services/geminiClient.js'))),
    sdk_version: require('../../node_modules/@google/genai/package.json').version, images: dataset.images,
  };
  return { ...protocol, fingerprint: sha(JSON.stringify(protocol)), created_at: new Date().toISOString(), relocation: dataset.relocation, excluded_root_files: dataset.excluded_root_files };
}
function scrub(value, apiKey) {
  let text = JSON.stringify(value);
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return JSON.parse(text.replace(/AIza[0-9A-Za-z_-]{8,}/g, '[REDACTED]').replace(/AQ\.[0-9A-Za-z_-]{20,}/g, '[REDACTED]').replace(/sk-[0-9A-Za-z_-]{20,}/g, '[REDACTED]'));
}
async function atomicJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temp, file);
}
// Extractor injection is only for offline tests. The CLI has no mock mode.
function retryableRecord(record) {
  if (record.status === 'in_progress') return true;
  if (record.status !== 'error') return false;
  const attempt = record.attempts?.at(-1);
  if (attempt?.status === 'success') return false; // Invalid JSON/schema needs review, not a capacity retry.
  return [408,429,500,502,503,504].includes(Number(attempt?.http_status || record.error?.status))
    || /abort|fetch failed|timeout/i.test(record.error?.message || '');
}
async function recoverStaleLock(out) {
  const file = path.join(out, '.run.lock');
  if (!await exists(file)) return;
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Number.isInteger(saved.pid) || saved.pid <= 0) throw new Error('Lock không có PID hợp lệ; cần kiểm tra thủ công.');
  try { process.kill(saved.pid, 0); }
  catch (error) {
    if (error.code !== 'ESRCH') throw new Error('Không xác minh được tiến trình cũ; không tự gỡ lock.');
    await fs.mkdir(path.join(out, 'history'), { recursive: true });
    await fs.rename(file, path.join(out, 'history', `stale-lock-${Date.now()}-${crypto.randomUUID()}.json`));
    return;
  }
  throw new Error(`Tiến trình ${saved.pid} vẫn còn; không chạy chồng lượt thực nghiệm.`);
}
async function runExperiment({ out, manifest, apiKey, connection, extract, limit = Infinity, log = console.log, shouldStop = () => false, retryErrors = false, retryImageIds = [], stopOnError = false }) {
  const selected = new Set(retryImageIds);
  for (const id of selected) if (!manifest.images.some((image) => image.image_id === id)) throw new Error(`Mã ảnh không thuộc manifest: ${id}`);
  await fs.mkdir(path.join(out, 'results'), { recursive: true });
  const lockFile = path.join(out, '.run.lock');
  const lock = await fs.open(lockFile, 'wx').catch((e) => { throw new Error(e.code === 'EEXIST' ? 'Có .run.lock: một lượt đang chạy hoặc lần trước bị dừng đột ngột. Kiểm tra trước khi xóa lock.' : e.message); });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const mf = path.join(out, 'manifest.json');
    if (await exists(mf)) {
      if (JSON.parse(await fs.readFile(mf, 'utf8')).fingerprint !== manifest.fingerprint) throw new Error('Prompt/schema/model/ngữ cảnh/tập ảnh đã thay đổi. Dùng --name mới, không trộn cấu hình.');
    } else await atomicJson(mf, manifest);
    let called = 0; let skipped = 0;
    for (const image of manifest.images) {
      if (selected.size && !selected.has(image.image_id)) { skipped++; continue; }
      const file = path.join(out, 'results', `${image.image_id}.json`);
      if (await exists(file)) {
        const previous = JSON.parse(await fs.readFile(file, 'utf8'));
        if ((!retryErrors && !selected.has(image.image_id)) || previous.status === 'success') { skipped++; log(`Bỏ qua ${image.image_id}: đã có JSON.`); continue; }
        // Only an explicit per-image request may retry JSON/schema failures.
        // The scheduled --retry-errors mode keeps its original safety gate.
        if (!retryableRecord(previous) && !selected.has(image.image_id)) return { called, skipped, blocked: image.image_id, reason: 'Lỗi không phải quá tải tạm thời; cần kiểm tra trước khi retry.' };
        if (called >= limit || shouldStop()) break;
        await fs.mkdir(path.join(out, 'history'), { recursive: true });
        await fs.rename(file, path.join(out, 'history', `${image.image_id}-${Date.now()}-${crypto.randomUUID()}.json`));
      }
      if (called >= limit || shouldStop()) break;
      const started = Date.now();
      const record = { ...image, protocol_fingerprint: manifest.fingerprint, fixture: manifest.fixture, provider: manifest.settings.provider, base_url: manifest.settings.baseUrl, status: 'in_progress', started_at: new Date().toISOString(), elapsed_ms: null, model_used: null, model_version: null, attempts: [], gemini: null, pipeline_result: null, raw_text: null, error: null };
      // Reserve before calling: do not silently repeat a possibly billed request
      // after a hard interruption. Completed/error JSONs are also never retried.
      await fs.writeFile(file, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
      log(`Đang trích xuất ${image.image_id} (${image.group})...`);
      try {
        const buffer = await fs.readFile(path.join(backendRoot, image.source_path));
        if (sha(buffer) !== image.image_sha256) throw new Error('Ảnh đã thay đổi sau khi tạo manifest.');
        const r = await extract([{ buffer, mimetype: image.mime_type }], { apiKey, connection, buyer: manifest.buyer });
        Object.assign(record, { status: 'success', provider_used: r.provider_used, base_url_used: r.base_url_used, prompt_used: r.prompt_used, prompt_failures: r.prompt_failures || [], model_used: r.model_used, model_version: r.model_version, attempts: r.attempts, raw_text: r.raw_text, gemini: r.raw_json, pipeline_result: r.invoice, usage: r.usage || null });
      } catch (e) {
        const d = e.diagnostics || {};
        Object.assign(record, { status: 'error', provider_used: d.provider_used || null, base_url_used: d.base_url_used || null, prompt_used: d.prompt_used || null, prompt_failures: d.prompt_failures || [], model_used: d.model_used || null, model_version: d.model_version || null, attempts: d.attempts || [], raw_text: d.raw_text || null, gemini: d.raw_json || null, transport_responses: d.transport_responses || [], error: { name: e.name, status: e.statusCode || null, message: e.message } });
      }
      record.elapsed_ms = Date.now() - started; record.finished_at = new Date().toISOString();
      await atomicJson(file, scrub(record, apiKey)); called++;
      log(`${image.image_id}: ${record.status}; ${record.elapsed_ms} ms.`);
      if (stopOnError && record.status !== 'success') break;
    }
    return { called, skipped };
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
// Raw CSV, no calculations and no automatic grading. Empty/null stays blank.
const docFields = ['supplier_name', 'supplier_phone', 'supplier_address', 'supplier_tax_code', 'invoice_number', 'invoice_date', 'total_amount'];
const itemFields = ['name', 'unit', 'quantity', 'unit_price', 'total_price'];
const csvHeaders = ['image_id', 'group', 'kind', 'source_path', 'item_no', ...docFields, ...docFields.map((f) => `${f}_review`), ...itemFields, ...itemFields.map((f) => `${f}_review`), ...itemFields.map((f) => `${f}_actual`), 'row_review', 'notes'];
function csvCell(value) { return '"' + String(value ?? '').replace(/"/g, '""') + '"'; }
async function exportCsv(out, _manifest, records) {
  const rows = [csvHeaders];
  for (const r of records) {
    if (!r || r.status !== 'success') continue;
    const d = r.gemini;
    const document = [d.supplier.name, d.supplier.phone, d.supplier.address, d.supplier.tax_code, d.invoice.number, d.invoice.date, d.total_amount];
    d.items.forEach((item, index) => rows.push([r.image_id, r.group, r.kind, r.source_path, index + 1, ...document, ...docFields.map(() => ''), ...itemFields.map((f) => item[f]), ...itemFields.map(() => ''), ...itemFields.map(() => ''), '', '']));
  }
  const file = path.join(out, 'review.csv');
  // Do not destroy annotations if a human has started reviewing the first CSV.
  const target = await exists(file) ? path.join(out, `review-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.csv`) : file;
  await fs.writeFile(target, '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n', { encoding: 'utf8', flag: 'wx' });
  return target;
}
async function loadResults(out) {
  const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8')); const records = [];
  for (const image of manifest.images) {
    const file = path.join(out, 'results', `${image.image_id}.json`);
    const record = await exists(file) ? JSON.parse(await fs.readFile(file, 'utf8')) : null;
    if (record && (record.image_id !== image.image_id || record.protocol_fingerprint !== manifest.fingerprint)) throw new Error(`JSON không khớp manifest: ${image.image_id}`);
    records.push(record);
  }
  return { manifest, records };
}
module.exports = { backendRoot, discoverDataset, outputDirectory, buildManifest, runExperiment, exportCsv, loadResults, csvHeaders, atomicJson, retryableRecord, recoverStaleLock };
