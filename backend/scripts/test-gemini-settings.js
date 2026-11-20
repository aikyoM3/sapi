// Offline browser interaction test. API responses are fixtures, never real keys.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

async function main() {
  const server = http.createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (!['/index.html', '/app.js'].includes(name)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(await fs.readFile(path.resolve(__dirname, '../../frontend', name.slice(1))));
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.SAPI_TEST_BROWSER || 'msedge' });
    const page = await browser.newPage();
    const errors = []; const saves = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let state = { connected: true, source: 'development', devCredentialsAvailable: true,
      baseUrl: 'https://generativelanguage.googleapis.com' };
    // Stub external assets too; only control behaviour is tested, not CSS layout.
    await page.route('https://**/*', (route) => route.fulfill({ body: route.request().resourceType() === 'stylesheet' ? '.d-none{display:none!important}.modal{display:none}' : '' }));
    await page.route('**/api/**', async (route) => {
      const name = new URL(route.request().url()).pathname;
      let data = {};
      if (name === '/api/auth/me') data = { user: { userId: 1, username: 'OFFLINE' } };
      else if (name === '/api/invoices') data = [];
      else if (name === '/api/auth/profile') data = { store_name: 'OFFLINE' };
      else if (name === '/api/integrations/kiotviet/status') data = { connected: false };
      else if (name === '/api/integrations/gemini/status') data = state;
      else if (name === '/api/integrations/gemini/connect') {
        const body = route.request().postDataJSON(); saves.push(body);
        state = { ...state, connected: true, source: body.useDevCredentials ? 'development' : 'stored',
          baseUrl: body.useDevCredentials ? 'https://generativelanguage.googleapis.com' : body.baseUrl };
        data = { connected: true };
      }
      await route.fulfill({ json: data });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.locator('#edit-connections').click();
    await page.locator('#gemini-edit').click();
    assert(await page.locator('#gemini-api-key').isDisabled());
    assert.equal(await page.locator('#gemini-host').inputValue(), 'https://generativelanguage.googleapis.com');
    assert(await page.locator('#gemini-host').isDisabled());
    assert(!(await page.content()).includes('shopaikey'), 'No development vendor in the DOM.');
    await page.locator('#gemini-use-dev').uncheck();
    assert(await page.locator('#gemini-api-key').isEditable());
    assert(await page.locator('#gemini-host').isEditable());
    assert.equal(await page.locator('#gemini-host').inputValue(), 'https://generativelanguage.googleapis.com');
    await page.locator('#gemini-api-key').fill('AIzaOFFLINE_TEST_ONLY');
    await page.locator('#gemini-connect').click();
    await page.waitForFunction(() => document.querySelector('#gemini-status').textContent.includes('key riêng'));
    assert.deepEqual(saves[0], { apiKey: 'AIzaOFFLINE_TEST_ONLY', baseUrl: 'https://generativelanguage.googleapis.com' });
    await page.locator('#gemini-edit').click();
    await page.locator('#gemini-api-key').fill('sk-OFFLINE_TEST_ONLY');
    await page.locator('#gemini-host').fill('https://approved-gateway.invalid');
    await page.locator('#gemini-connect').click();
    await page.waitForFunction(() => document.querySelector('#gemini-status').textContent.includes('approved-gateway.invalid'));
    assert.deepEqual(saves[1], { apiKey: 'sk-OFFLINE_TEST_ONLY', baseUrl: 'https://approved-gateway.invalid' });
    await page.locator('#gemini-edit').click();
    await page.locator('#gemini-use-dev').check();
    assert(await page.locator('#gemini-host').isDisabled());
    await page.locator('#gemini-cancel').click();
    await page.locator('#gemini-edit').click();
    assert(!await page.locator('#gemini-use-dev').isChecked());
    assert.equal(await page.locator('#gemini-host').inputValue(), 'https://approved-gateway.invalid');
    assert.deepEqual(errors, []);
    await page.locator('#gemini-use-dev').check();
    await page.locator('#gemini-connect').click();
    await page.waitForFunction(() => document.querySelector('#gemini-status').textContent.includes('key development'));
    assert.deepEqual(saves[2], { useDevCredentials: true });
    assert(!(await page.locator('#gemini-status').textContent()).includes('https://'));
    console.log('PASS: personal Google default/editable host, hidden development config, save payloads, source switching and cancel restore. No real APIs or credentials.');
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
