// Browser interaction tests with fixtures only. Never sends images to Gemini/KiotViet.
// Requires Playwright (set NODE_PATH to an existing installation if not local).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '../../frontend');
  const server = http.createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (!['/app.js', '/invoice-correction.html', '/upload-invoice.html', '/index.html'].includes(name)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(await fs.readFile(path.join(root, name.slice(1))));
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.SAPI_TEST_BROWSER || 'msedge' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('dialog', () => { throw new Error('Unexpected native browser alert/confirm'); });
    const gemini = { supplier: { name: 'Test supplier' }, invoice: {}, items: [
      { name: 'Retained', quantity: 2, unit: 'Cái', unit_price: 100, total_price: 200 },
      { name: 'Deleted', quantity: 3, unit: 'Cái', unit_price: 10, total_price: 30 },
    ], total_amount: 230 };
    const extraction = { gemini, corresponding: { supplier: { supplier_id: 1, name: 'Test supplier' }, items: [{ product_id: 11, name: 'Retained' }, { product_id: 12, name: 'Deleted' }] } };
    let confirmed; let confirmationRequests = 0; let passwordRequests = 0; let uploadMode = false; let retryRequests = 0;
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url()); const pathname = url.pathname;
      let data = {};
      if (pathname === '/api/auth/me') data = { user: { userId: 7, username: 'test' } };
      else if (uploadMode && pathname.endsWith('/qr')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
      else if (uploadMode && pathname.endsWith('/process')) { retryRequests++; data = { status: 'PROCESSING' }; }
      else if (uploadMode && pathname.endsWith('/status')) data = { status: retryRequests ? 'PROCESSING' : 'FAILED', imageCount: 1, error: 'Test Gemini timeout' };
      else if (pathname.endsWith('/confirm')) { confirmed = route.request().postDataJSON(); confirmationRequests++; data = { status: 'SYNCED', invoiceId: 1 }; }
      else if (pathname === '/api/products/search') data = [{ product_id: 21, product_name: 'New Product', product_code: 'HIDDEN-CODE', primary_unit: 'Hộp' }, { product_id: 22, product_name: 'Next Product', product_code: 'OTHER-CODE', primary_unit: 'Chai' }];
      else if (pathname === '/api/auth/password') { passwordRequests++; return route.fulfill({ status: 400, json: { error: 'Mật khẩu hiện tại không đúng.' } }); }
      else if (pathname.includes('/kiotviet/status') || pathname.includes('/gemini/status')) data = { connected: false };
      else if (pathname.startsWith('/api/invoice-sessions/')) data = { status: 'READY_FOR_REVIEW', extraction, images: [] };
      return route.fulfill({ json: data });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/invoice-correction.html?session=test');
    // A passing interaction test without Tabler CSS is not a layout check.
    assert.notEqual(await page.locator('.form-control').first().evaluate((element) => getComputedStyle(element).display), 'none', 'Tabler CSS did not load');
    await page.locator('.invoice-line').nth(1).waitFor(); await page.locator('#settings-icon').waitFor();
    assert.equal(await page.locator('#subtotal').textContent(), '230');
    const secondProduct = page.locator('.product-name').nth(1); await secondProduct.fill('New');
    await page.locator('.invoice-line').nth(1).locator('.suggestion').first().waitFor();
    assert(!(await page.locator('.invoice-line').nth(1).locator('.suggestions').textContent()).includes('HIDDEN-CODE'));
    await secondProduct.press('ArrowDown'); await secondProduct.press('Enter');
    assert.equal(await secondProduct.inputValue(), 'New Product');
    assert.equal(await page.locator('.line-unit').nth(1).inputValue(), 'Hộp');
    const original = await page.locator('#gemini-json').textContent();
    await page.locator('.delete-line').nth(1).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.invoice-line').count(), 2);
    await page.locator('.delete-line').nth(1).click();
    await page.locator('[data-accept]').click();
    await page.waitForFunction(() => document.querySelectorAll('.invoice-line').length === 1);
    assert.equal(await page.locator('#subtotal').textContent(), '200');
    assert.equal(await page.locator('#gemini-json').textContent(), original);
    assert.equal(await page.locator('.invoice-line td').first().textContent(), '1');
    assert.equal(await page.locator('#sapi-toasts .alert').count(), 1);
    await page.locator('.line-quantity').fill(''); await page.locator('#confirm').click(); assert.equal(confirmationRequests, 0);
    await page.locator('.line-quantity').fill('2');
    await page.locator('#discount').fill('201'); assert(await page.locator('#confirm').isDisabled());
    await page.locator('#discount').fill('20'); assert.equal(await page.locator('#grand-total').textContent(), '180');
    await page.locator('#confirm').click();
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Đã lưu hóa đơn'));
    assert.equal(confirmationRequests, 1); assert.equal(confirmed.items.length, 1); assert.equal(confirmed.items[0].productId, 11); assert.equal(confirmed.items[0].externalName, 'Retained');
    await page.goto(base + '/invoice-correction.html?session=test');
    await page.locator('.delete-line').nth(1).waitFor();
    for (let index = 0; index < 2; index++) { await page.locator('.delete-line').first().click(); await page.locator('[data-accept]').click(); }
    await page.waitForFunction(() => document.querySelectorAll('.invoice-line').length === 0);
    assert(await page.locator('#confirm').isDisabled()); assert(await page.locator('#items-warning').isVisible()); assert.equal(confirmationRequests, 1);

    await page.locator('#settings-icon').click();
    await page.locator('#font-size').selectOption('large');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '18px');
    await page.reload(); await page.locator('#settings-icon').waitFor();
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '18px');
    await page.locator('#settings-icon').click();
    await page.locator('#current-password').fill('anything'); await page.locator('#new-password').fill('NewPassword123'); await page.locator('#confirm-password').fill('Mismatch123');
    await page.locator('#save-password').click(); assert.equal(passwordRequests, 0);
    await page.locator('#confirm-password').fill('NewPassword123'); await page.locator('#save-password').click();
    await page.waitForFunction(() => document.querySelector('#password-message').textContent.includes('hiện tại không đúng'));
    assert.equal(passwordRequests, 1); assert(!page.url().includes('/login'));
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-icon');
    assert.equal(await page.locator('#current-password').inputValue(), '');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#settings-icon').click(); await page.locator('#reset-font-size').click();
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '16px');
    assert.equal(await page.locator('#settings-modal').evaluate((element) => getComputedStyle(element).position), 'fixed');
    assert(await page.locator('#settings-modal .modal-dialog').evaluate((element) => element.getBoundingClientRect().width <= innerWidth));
    assert.equal(await page.locator('#password-message').textContent(), '');
    assert.equal(await page.locator('#password-message').getAttribute('class'), '');
    if (process.env.SAPI_TEST_SCREENSHOT) await page.screenshot({ path: process.env.SAPI_TEST_SCREENSHOT, fullPage: true });
    uploadMode = true;
    await page.goto(base + '/upload-invoice.html?session=test');
    await page.waitForFunction(() => document.querySelector('#process').textContent === 'Thử lại');
    assert((await page.locator('#status').textContent()).includes('Test Gemini timeout'));
    await page.locator('#process').click();
    await page.waitForFunction(() => document.querySelector('#process').textContent.includes('Đang xử lý'));
    assert.equal(retryRequests, 1); assert(await page.locator('#process').isDisabled()); assert(await page.locator('#image-input').isDisabled());
    assert.deepEqual(pageErrors, []);
    console.log('PASS: keyboard product selection/unit autofill, hidden product code, delete/cancel, totals/discount, unchanged OCR JSON, confirmation payload, empty/missing data, toast, font persistence, password feedback, modal Escape/focus, mobile settings and upload retry/spinner.');
    await context.close();
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
