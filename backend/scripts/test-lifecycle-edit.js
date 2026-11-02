require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const { Pool } = require('pg');
const { buildBuyerContext, removeBuyerFromSupplier } = require('../services/geminiInvoiceService');

const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
const base = 'http://localhost:3000';
const suffix = Date.now();
const names = [`target_a_${suffix}`, `target_b_${suffix}`];
const password = 'Targeted123!';

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  try {
    for (const username of names) await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const login = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: names[0], password }) });
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    const savedProfile = await api('/api/auth/profile', { method:'PUT', headers:{ Cookie:cookie,'Content-Type':'application/json' }, body:JSON.stringify({ storeName:'Cửa hàng A',taxCode:'0312345678',address:'Quận 1',phone:'0901 234 567',email:'store@example.com' }) });
    assert.equal(savedProfile.response.status, 200);
    const profile = await api('/api/auth/profile', { headers:{ Cookie:cookie } });
    assert.deepEqual(profile.body, { store_name:'Cửa hàng A',tax_code:'0312345678',address:'Quận 1',phone:'0901 234 567',email:'store@example.com' });
    const clearedProfile = await api('/api/auth/profile', { method:'PUT', headers:{ Cookie:cookie,'Content-Type':'application/json' }, body:JSON.stringify({}) });
    assert.equal(clearedProfile.response.status, 200); assert(Object.values(clearedProfile.body).every((value)=>value === null));
    const buyer = { store_name:'Cửa hàng A',tax_code:'0312345678',phone:'0901 234 567' };
    const buyerContext = buildBuyerContext(buyer); assert(buyerContext.includes('NGƯỜI MUA')); assert(!buyerContext.includes('undefined') && !buyerContext.includes('Địa chỉ:') && !buyerContext.includes('Email:'));
    const filtered = removeBuyerFromSupplier({ supplier:{ name:'Cửa hàng A',phone:null,address:'X',tax_code:'0312-345-678' } }, buyer);
    assert(Object.values(filtered.supplier).every((value)=>value === null));
    const missingKiot = await api('/api/integrations/kiotviet/connect',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'}); assert.equal(missingKiot.response.status,400); assert.equal(missingKiot.body.code,'KIOTVIET_VALIDATION');
    const noKiotSync = await api('/api/integrations/kiotviet/sync',{method:'POST',headers:{Cookie:cookie}}); assert.equal(noKiotSync.response.status,409); assert.equal(noKiotSync.body.code,'KIOTVIET_NOT_CONNECTED');
    const missingGemini = await api('/api/integrations/gemini/connect',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'}); assert.equal(missingGemini.response.status,400); assert.equal(missingGemini.body.code,'GEMINI_KEY_REQUIRED');
    const users = await pool.query('SELECT user_id,username FROM users WHERE username=ANY($1)', [names]);
    const ids = Object.fromEntries(users.rows.map((row) => [row.username, row.user_id]));
    const unknownSupplier = await pool.query("SELECT supplier_name,phone_number,address,kiotviet_id,kiotviet_modified_at FROM supplier WHERE user_id=$1 AND LOWER(supplier_name)=LOWER('Không xác định')", [ids[names[0]]]);
    assert.equal(unknownSupplier.rowCount, 1); assert(Object.entries(unknownSupplier.rows[0]).every(([key,value])=>key==='supplier_name' ? value==='Không xác định' : value===null));
    const geminiDevStatus = await api('/api/integrations/gemini/status',{headers:{Cookie:cookie}});
    if (geminiDevStatus.body.devCredentialsAvailable) { assert.equal(geminiDevStatus.body.connected,true); assert.equal(geminiDevStatus.body.source,'development'); }
    const tokenWaiting = `waiting_${suffix}`; const tokenReady = `ready_${suffix}`; const tokenOther = `other_${suffix}`;
    await pool.query(`INSERT INTO invoicesession(user_id,session_token,status,expires_at) VALUES
      ($1,$2,'WAITING_IMAGES',NOW()+INTERVAL '1 hour'),($1,$3,'READY_FOR_REVIEW',NOW()+INTERVAL '1 hour'),($4,$5,'READY_FOR_REVIEW',NOW()+INTERVAL '1 hour')`, [ids[names[0]], tokenWaiting, tokenReady, ids[names[1]], tokenOther]);
    const listed = await api('/api/invoices', { headers: { Cookie: cookie } });
    assert(!listed.body.some((row) => row.session_token === tokenWaiting));
    assert(listed.body.some((row) => row.session_token === tokenReady && row.status === 'INCOMPLETE'));
    assert.equal((await api(`/api/invoice-sessions/${tokenOther}`, { method: 'DELETE', headers: { Cookie: cookie } })).response.status, 404);
    assert.equal((await api(`/api/invoice-sessions/${tokenReady}`, { method: 'DELETE', headers: { Cookie: cookie } })).response.status, 204);

    const products = await pool.query(`INSERT INTO product(user_id,product_name,quantity) VALUES($1,'Own',1),($2,'Other',1) RETURNING product_id,user_id`, [ids[names[0]], ids[names[1]]]);
    const ownProduct = products.rows.find((row) => row.user_id === ids[names[0]]).product_id; const otherProduct = products.rows.find((row) => row.user_id === ids[names[1]]).product_id;
    const suppliers = await pool.query(`INSERT INTO supplier(user_id,supplier_name) VALUES($1,'Own supplier'),($2,'Other supplier') RETURNING supplier_id,user_id`, [ids[names[0]], ids[names[1]]]);
    const ownSupplier = suppliers.rows.find((row) => row.user_id === ids[names[0]]).supplier_id; const otherSupplier = suppliers.rows.find((row) => row.user_id === ids[names[1]]).supplier_id;
    assert.equal((await api(`/api/products/${ownProduct}`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ productName: 'Updated', quantity: 2 }) })).response.status, 200);
    assert.equal((await api(`/api/products/${otherProduct}`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ productName: 'Blocked', quantity: 2 }) })).response.status, 404);
    assert.equal((await api(`/api/suppliers/${ownSupplier}`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ supplierName: 'Updated supplier' }) })).response.status, 200);
    assert.equal((await api(`/api/suppliers/${otherSupplier}`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ supplierName: 'Blocked supplier' }) })).response.status, 404);
    const invoices = await pool.query(`INSERT INTO purchaseinvoice(user_id,supplier_id,total_amount,status) VALUES
      ($1,$2,10,'PENDING_SYNC'),($3,$4,10,'PENDING_SYNC'),($1,$2,10,'SYNCED') RETURNING invoice_id,user_id,status`, [ids[names[0]], ownSupplier, ids[names[1]], otherSupplier]);
    const ownPending = invoices.rows.find((row) => row.user_id === ids[names[0]] && row.status === 'PENDING_SYNC').invoice_id;
    const otherPending = invoices.rows.find((row) => row.user_id === ids[names[1]]).invoice_id;
    const ownSynced = invoices.rows.find((row) => row.user_id === ids[names[0]] && row.status === 'SYNCED').invoice_id;
    assert.equal((await api(`/api/invoices/${otherPending}`, { method: 'DELETE', headers: { Cookie: cookie } })).response.status, 404);
    assert.equal((await api(`/api/invoices/${ownSynced}`, { method: 'DELETE', headers: { Cookie: cookie } })).response.status, 409);
    assert.equal((await api(`/api/invoices/${ownPending}`, { method: 'DELETE', headers: { Cookie: cookie } })).response.status, 204);
    const mappings = await pool.query(`INSERT INTO productmapping(supplier_id,local_product_id,provider_product_name) VALUES($1,$2,'Own map'),($3,$4,'Other map') RETURNING mapping_id,local_product_id`, [ownSupplier, ownProduct, otherSupplier, otherProduct]);
    const ownMapping = mappings.rows.find((row) => row.local_product_id === ownProduct).mapping_id; const otherMapping = mappings.rows.find((row) => row.local_product_id === otherProduct).mapping_id;
    assert.equal((await api(`/api/product-mappings/${ownMapping}`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ providerProductName: 'Updated map' }) })).response.status, 200);
    assert.equal((await api(`/api/product-mappings/${otherMapping}`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ providerProductName: 'Blocked map' }) })).response.status, 404);
    const appSource=fs.readFileSync('../frontend/app.js','utf8'); const indexSource=fs.readFileSync('../frontend/index.html','utf8');
    ['1. Thông tin cửa hàng','2. KiotViet','3. Gemini API'].forEach((label)=>assert(appSource.includes(label)));
    ['store-view','store-form','store-edit','kiot-view','kiot-form','gemini-view','gemini-form'].forEach((id)=>assert(appSource.includes(`id="${id}"`)));
    const geminiGuide=fs.readFileSync('../frontend/gemini-guide.html','utf8'); assert(geminiGuide.includes('https://aistudio.google.com/app/apikey')); assert(geminiGuide.includes('Create API key')); assert(!geminiGuide.includes('Nội dung hướng dẫn sẽ được cập nhật'));
    assert(!appSource.includes("['product_id', 'Product ID']") && !appSource.includes("['supplier_id', 'Supplier ID']") && !appSource.includes("['mapping_id', 'Mapping ID']"));
    assert(!indexSource.includes('kiotviet-modal') && !indexSource.includes('kiotviet-integration.js'));
    const navbar=appSource.match(/pageRoot\.insertAdjacentHTML\('afterbegin',[\s\S]*?\);/)[0];
    const order=['connection-status','edit-connections','navbar-sync','Xin chào','data-logout'].map((text)=>navbar.indexOf(text)); assert(order.every((value,index)=>index===0 || value>order[index-1]));
    console.log('TARGETED_TEST_SUCCESS: store profile nullable, buyer OCR guard, shared modal/navbar, integration validation, existing lifecycle/ownership');
  } finally {
    const users = await pool.query('SELECT user_id FROM users WHERE username=ANY($1)', [names]); const userIds = users.rows.map((row) => row.user_id);
    if (userIds.length) {
      await pool.query('DELETE FROM purchaseinvoiceitem WHERE invoice_id IN (SELECT invoice_id FROM purchaseinvoice WHERE user_id=ANY($1))', [userIds]);
      await pool.query('DELETE FROM purchaseinvoice WHERE user_id=ANY($1)', [userIds]);
      await pool.query('DELETE FROM productmapping WHERE local_product_id IN (SELECT product_id FROM product WHERE user_id=ANY($1))', [userIds]);
      await pool.query('DELETE FROM invoicesessionimage WHERE invoice_session_id IN (SELECT invoice_session_id FROM invoicesession WHERE user_id=ANY($1))', [userIds]);
      await pool.query('DELETE FROM invoicesession WHERE user_id=ANY($1)', [userIds]);
      await pool.query('DELETE FROM product WHERE user_id=ANY($1)', [userIds]); await pool.query('DELETE FROM supplier WHERE user_id=ANY($1)', [userIds]);
      await pool.query('DELETE FROM users WHERE user_id=ANY($1)', [userIds]);
    }
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
