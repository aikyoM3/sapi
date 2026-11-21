require('dotenv').config();
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
const base = 'http://localhost:3000';
const username = `delete_test_${Date.now()}`;
let userId;

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  return { response, body: response.status === 204 ? {} : await response.json().catch(() => ({})) };
}

async function main() {
  try {
    await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'DeleteTest123!' }) });
    const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'DeleteTest123!' }) });
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    userId = (await pool.query('SELECT user_id FROM users WHERE username=$1', [username])).rows[0].user_id;
    const supplierId = (await pool.query("INSERT INTO supplier(user_id,supplier_name) VALUES($1,'Delete supplier') RETURNING supplier_id", [userId])).rows[0].supplier_id;
    const productId = (await pool.query("INSERT INTO product(user_id,product_name,product_code) VALUES($1,'Delete product','DELETE-TEST') RETURNING product_id", [userId])).rows[0].product_id;
    const mappingId = (await pool.query("INSERT INTO productmapping(supplier_id,local_product_id,provider_product_name) VALUES($1,$2,'External delete product') RETURNING mapping_id", [supplierId, productId])).rows[0].mapping_id;
    const supplierMappingId = (await pool.query("INSERT INTO suppliermapping(local_supplier_id,provider_supplier_name) VALUES($1,'External delete supplier') RETURNING supplier_mapping_id", [supplierId])).rows[0].supplier_mapping_id;
    const invoiceId = (await pool.query("INSERT INTO purchaseinvoice(user_id,supplier_id,total_amount,status,kiotviet_purchase_order_id) VALUES($1,$2,10,'SYNCED',999999) RETURNING invoice_id", [userId, supplierId])).rows[0].invoice_id;
    await pool.query('INSERT INTO purchaseinvoiceitem(invoice_id,product_id,quantity,unit_price,total_price) VALUES($1,$2,1,10,10)', [invoiceId, productId]);

    assert.equal((await request(`/api/invoices/${invoiceId}`, { method: 'DELETE', headers: { Cookie: cookie } })).response.status, 204);
    assert.equal((await pool.query('SELECT 1 FROM purchaseinvoice WHERE invoice_id=$1', [invoiceId])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM productmapping WHERE mapping_id=$1', [mappingId])).rowCount, 1, 'Deleting invoice must preserve product mapping');
    assert.equal((await request(`/api/product-mappings/${mappingId}`, { method: 'DELETE', headers: { Cookie: cookie } })).response.status, 204);
    assert.equal((await request(`/api/supplier-mappings/${supplierMappingId}`, { method: 'DELETE', headers: { Cookie: cookie } })).response.status, 204);
    assert.equal((await pool.query('SELECT 1 FROM product WHERE product_id=$1', [productId])).rowCount, 1, 'Deleting mapping must preserve product');
    assert.equal((await pool.query('SELECT 1 FROM supplier WHERE supplier_id=$1', [supplierId])).rowCount, 1, 'Deleting mapping must preserve supplier');
    console.log('PASS: synced invoice local delete preserves mappings; product/supplier mappings delete independently and preserve catalog data.');
  } finally {
    if (userId) {
      await pool.query('DELETE FROM productmapping WHERE local_product_id IN (SELECT product_id FROM product WHERE user_id=$1)', [userId]);
      await pool.query('DELETE FROM suppliermapping WHERE local_supplier_id IN (SELECT supplier_id FROM supplier WHERE user_id=$1)', [userId]);
      await pool.query('DELETE FROM purchaseinvoiceitem WHERE invoice_id IN (SELECT invoice_id FROM purchaseinvoice WHERE user_id=$1)', [userId]);
      await pool.query('DELETE FROM purchaseinvoice WHERE user_id=$1', [userId]);
      await pool.query('DELETE FROM product WHERE user_id=$1', [userId]); await pool.query('DELETE FROM supplier WHERE user_id=$1', [userId]); await pool.query('DELETE FROM users WHERE user_id=$1', [userId]);
    }
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
