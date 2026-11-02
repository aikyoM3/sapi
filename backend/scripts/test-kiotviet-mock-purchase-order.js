require('dotenv').config();
const assert = require('assert');
const { Pool } = require('pg');

const pool = new Pool({ host:process.env.DB_HOST,port:Number(process.env.DB_PORT)||5432,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD });
const base='http://localhost:3000'; const username=`mock_po_${Date.now()}`; const password='MockTarget123!';
async function api(path,options={}) { const response=await fetch(`${base}${path}`,options); const body=response.status===204?{}:await response.json().catch(()=>({})); return {response,body}; }

async function main() {
  let userId;
  try {
    const mode=await api('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})}); assert.equal(mode.response.status,201);
    const login=await api('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})}); assert.equal(login.response.status,200);
    const cookie=login.response.headers.get('set-cookie').split(';')[0]; userId=(await pool.query('SELECT user_id FROM users WHERE username=$1',[username])).rows[0].user_id;
    const connected=await api('/api/integrations/kiotviet/connect',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({clientId:'mock-client',clientSecret:'mock-secret',retailer:'sapi-mock'})}); assert.equal(connected.response.status,200);
    const status=await api('/api/integrations/kiotviet/status',{headers:{Cookie:cookie}}); assert.equal(status.body.mode,'mock'); assert.equal(status.body.connected,true);
    const syncedData=await api('/api/integrations/kiotviet/sync',{method:'POST',headers:{Cookie:cookie}}); assert.equal(syncedData.response.status,200);

    const supplier=(await pool.query("INSERT INTO supplier(user_id,supplier_name) VALUES($1,'NCC Test') RETURNING supplier_id",[userId])).rows[0];
    const products=await pool.query("INSERT INTO product(user_id,product_code,product_name,quantity) VALUES($1,'SP-MOCK-01','Success item',1),($1,'MOCK-FAIL','Failure item',1) RETURNING product_id,product_code",[userId]);
    async function seedInvoice(productCode) {
      const invoice=(await pool.query("INSERT INTO purchaseinvoice(user_id,supplier_id,total_amount,status,invoice_number) VALUES($1,$2,125000,'PENDING_SYNC',$3) RETURNING invoice_id",[userId,supplier.supplier_id,`INV-${productCode}`])).rows[0];
      const product=products.rows.find((row)=>row.product_code===productCode);
      await pool.query('INSERT INTO purchaseinvoiceitem(invoice_id,product_id,quantity,unit,unit_price,total_price) VALUES($1,$2,2,\'Cái\',62500,125000)',[invoice.invoice_id,product.product_id]);
      return invoice.invoice_id;
    }
    const successId=await seedInvoice('SP-MOCK-01'); const success=await api(`/api/invoices/${successId}/sync`,{method:'POST',headers:{Cookie:cookie}}); assert.equal(success.response.status,200);
    const successRow=(await pool.query('SELECT status,kiotviet_purchase_order_id,kiotviet_purchase_order_code FROM purchaseinvoice WHERE invoice_id=$1',[successId])).rows[0]; assert.equal(successRow.status,'SYNCED'); assert(successRow.kiotviet_purchase_order_id); assert(successRow.kiotviet_purchase_order_code);
    const failureId=await seedInvoice('MOCK-FAIL'); const failure=await api(`/api/invoices/${failureId}/sync`,{method:'POST',headers:{Cookie:cookie}}); assert.equal(failure.response.status,502);
    const failureRow=(await pool.query('SELECT status,kiotviet_purchase_order_id FROM purchaseinvoice WHERE invoice_id=$1',[failureId])).rows[0]; assert.equal(failureRow.status,'PENDING_SYNC'); assert.equal(failureRow.kiotviet_purchase_order_id,null);
    const received=await fetch(`${base}/mock/kiotviet/purchaseorders`,{headers:{Authorization:'Bearer sapi-mock-access-token',Retailer:'sapi-mock'}}).then((response)=>response.json()); assert(received.data.some((order)=>order.id===Number(successRow.kiotviet_purchase_order_id)));
    console.log('MOCK_PURCHASE_ORDER_TEST_SUCCESS: PENDING_SYNC -> SYNCED after POST; failed POST remains PENDING_SYNC');
  } finally {
    if (userId) {
      await pool.query('DELETE FROM purchaseinvoiceitem WHERE invoice_id IN (SELECT invoice_id FROM purchaseinvoice WHERE user_id=$1)',[userId]);
      await pool.query('DELETE FROM purchaseinvoice WHERE user_id=$1',[userId]); await pool.query('DELETE FROM productmapping WHERE local_product_id IN (SELECT product_id FROM product WHERE user_id=$1)',[userId]);
      await pool.query('DELETE FROM product WHERE user_id=$1',[userId]); await pool.query('DELETE FROM supplier WHERE user_id=$1',[userId]); await pool.query('DELETE FROM kiotvietbranch WHERE user_id=$1',[userId]); await pool.query('DELETE FROM kiotviet_connections WHERE user_id=$1',[userId]); await pool.query('DELETE FROM users WHERE user_id=$1',[userId]);
    }
    await pool.end();
  }
}
main().catch((error)=>{console.error(error);process.exitCode=1});
