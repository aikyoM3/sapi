// Small shared UI helpers. No Bootstrap/Tabler JavaScript dependency is required.
window.SapiUI = (() => {
  const fontSizes = { small: '14px', default: '16px', large: '18px' };
  const fontKey = 'sapi.fontSize';
  const style = document.createElement('style');
  style.textContent = `
    .sapi-toasts{position:fixed;top:1rem;right:1rem;z-index:1100;width:min(24rem,calc(100vw - 2rem));pointer-events:none}
    .sapi-toasts .alert{pointer-events:auto;box-shadow:0 .25rem 1rem #0002;overflow-wrap:anywhere}
    .sapi-confirm{width:min(30rem,calc(100vw - 2rem));max-height:90vh;overflow:auto;border:1px solid var(--tblr-border-color,#ddd);border-radius:.5rem;padding:0;color:var(--tblr-body-color,#182433);background:var(--tblr-bg-surface,#fff)}
    .sapi-confirm::backdrop{background:#0008}
    .sapi-confirm .card-body{padding:1.25rem}.sapi-confirm .card-footer{padding:1rem}
    .sapi-confirm button{min-height:2.5rem}
  `;
  document.head.append(style);
  function savedFontSize() { try { return localStorage.getItem(fontKey) || 'default'; } catch { return 'default'; } }
  function setFontSize(value, persist = true) {
    const size = Object.hasOwn(fontSizes, value) ? value : 'default';
    document.documentElement.style.fontSize = fontSizes[size];
    document.documentElement.dataset.fontSize = size;
    if (persist) { try { localStorage.setItem(fontKey, size); } catch { return false; } }
    return true;
  }
  setFontSize(savedFontSize(), false);
  window.addEventListener('storage', (event) => { if (event.key === fontKey || event.key === null) setFontSize(savedFontSize(), false); });
  function notify(message, type = 'success', duration = type === 'danger' ? 0 : 6000) {
    let region = document.querySelector('#sapi-toasts');
    if (!region) { region = document.createElement('div'); region.id = 'sapi-toasts'; region.className = 'sapi-toasts'; region.setAttribute('aria-live', 'polite'); document.body.append(region); }
    const toast = document.createElement('div'); toast.className = `alert alert-${['success','danger','warning','info'].includes(type) ? type : 'info'} d-flex gap-3 align-items-start`;
    toast.setAttribute('role', type === 'danger' ? 'alert' : 'status');
    const content = document.createElement('span'); content.className = 'flex-fill'; content.textContent = message;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn-close'; close.setAttribute('aria-label', 'Đóng thông báo');
    let timer; const dismiss = () => { clearTimeout(timer); toast.remove(); }; close.addEventListener('click', dismiss);
    toast.append(content, close); region.append(toast);
    const startTimer = () => { clearTimeout(timer); if (duration > 0) timer = setTimeout(dismiss, duration); };
    toast.addEventListener('mouseenter', () => clearTimeout(timer)); toast.addEventListener('mouseleave', startTimer);
    toast.addEventListener('focusin', () => clearTimeout(timer)); toast.addEventListener('focusout', startTimer); startTimer();
  }
  let confirmationOpen = false;
  function confirmAction(message, { title = 'Xác nhận thao tác', confirmLabel = 'Xác nhận' } = {}) {
    if (confirmationOpen) return Promise.resolve(false);
    confirmationOpen = true;
    return new Promise((resolve) => {
      const opener = document.activeElement;
      const dialog = document.createElement('dialog'); dialog.className = 'sapi-confirm'; dialog.setAttribute('aria-labelledby', 'sapi-confirm-title'); dialog.setAttribute('aria-describedby', 'sapi-confirm-message');
      dialog.innerHTML = '<div class="card-body"><h3 id="sapi-confirm-title"></h3><p id="sapi-confirm-message" class="mb-0"></p></div><div class="card-footer d-flex justify-content-end gap-2"><button type="button" class="btn" data-dismiss autofocus>Quay lại</button><button type="button" class="btn btn-danger" data-accept></button></div>';
      dialog.querySelector('h3').textContent = title; dialog.querySelector('p').textContent = message; dialog.querySelector('[data-accept]').textContent = confirmLabel;
      dialog.querySelector('[data-dismiss]').addEventListener('click', () => dialog.close('cancel'));
      dialog.querySelector('[data-accept]').addEventListener('click', () => dialog.close('confirmed'));
      dialog.addEventListener('close', () => { const confirmed = dialog.returnValue === 'confirmed'; dialog.remove(); confirmationOpen = false; if (opener?.isConnected) opener.focus(); resolve(confirmed); }, { once: true });
      document.body.append(dialog); dialog.showModal();
    });
  }
  return { notify, confirmAction, setFontSize };
})();

const pageConfigs = {
  invoices: {
    endpoint: '/api/invoices',
    columns: [
      ['invoice_number', 'Mã hóa đơn'],
      ['supplier_name', 'Nhà cung cấp'],
      ['invoice_date', 'Ngày hóa đơn', formatDate],
      ['total_amount', 'Tổng tiền', formatAmount],
      ['status', 'Trạng thái', formatInvoiceStatus, true],
      ['actions', 'Thao tác', formatInvoiceActions, true],
    ],
  },
  products: {
    endpoint: '/api/products',
    columns: [
      ['product_code', 'Mã hàng'],
      ['product_name', 'Tên hàng'],
      ['primary_unit', 'Đơn vị chính'],
      ['quantity', 'Số lượng', formatAmount],
    ],
  },
  suppliers: {
    endpoint: '/api/suppliers',
    columns: [
      ['supplier_name', 'Tên nhà cung cấp'],
      ['phone_number', 'Số điện thoại'],
      ['address', 'Địa chỉ'],
    ],
  },
  mappings: {
    endpoint: '/api/product-mappings',
    columns: [
      ['supplier_name', 'Nhà cung cấp'],
      ['local_product_name', 'Tên hàng nội bộ'],
      ['provider_product_code', 'Mã hàng nhà cung cấp'],
      ['provider_product_name', 'Tên hàng nhà cung cấp'],
      ['provider_unit', 'Đơn vị nhà cung cấp'],
      ['local_unit', 'Đơn vị nội bộ'],
      ['actions', 'Thao tác', (_value, row) => editAction('mappings', row.mapping_id), true],
    ],
  },
  supplierMappings: {
    endpoint: '/api/supplier-mappings',
    columns: [
      ['local_supplier_name', 'Nhà cung cấp trong KiotViet'],
      ['provider_supplier_name', 'Tên nhà cung cấp trên hóa đơn'],
      ['actions', 'Thao tác', (_value, row) => editAction('supplierMappings', row.supplier_mapping_id), true],
    ],
  },
};

let loadedTableName = null;
let loadedTableRows = [];
let invoiceRefreshTimer = null;
const editConfigs = {
  mappings: { title: 'Chỉnh sửa dữ liệu đối chiếu', id: 'mapping_id', endpoint: '/api/product-mappings', fields: [['providerProductCode','provider_product_code','Mã hàng nhà cung cấp'],['providerProductName','provider_product_name','Tên hàng nhà cung cấp'],['providerUnit','provider_unit','Đơn vị nhà cung cấp'],['localUnit','local_unit','Đơn vị nội bộ']] },
  supplierMappings: { title: 'Chỉnh sửa đối chiếu nhà cung cấp', id: 'supplier_mapping_id', endpoint: '/api/supplier-mappings', fields: [['providerSupplierName','provider_supplier_name','Tên nhà cung cấp trên hóa đơn']] },
};

function formatDate(value) {
  return value ? new Intl.DateTimeFormat('vi-VN').format(new Date(value)) : '';
}

function formatAmount(value) {
  return value === null || value === undefined || value === ''
    ? ''
    : new Intl.NumberFormat('vi-VN').format(Number(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatInvoiceStatus(value, row = {}) {
  const labels = {
    INCOMPLETE: ['danger', 'Chưa hoàn thành'],
    QUEUED: ['secondary', 'Chờ xử lý ảnh'],
    PROCESSING: ['azure', 'Đang xử lý ảnh'],
    RETRY_WAIT: ['warning', 'Tạm hoãn, sẽ thử lại'],
    READY_FOR_REVIEW: ['blue', 'Chờ kiểm tra'],
    FAILED: ['danger', 'Xử lý ảnh thất bại'],
    PENDING_SYNC: ['warning', 'Chưa đồng bộ'],
    SYNCED: ['success', 'Đã hoàn thành'],
  };
  const [color, label] = labels[value] || ['secondary', value || 'Không rõ'];
  const detail = row.error_message ? `<small class="d-block text-secondary mt-1" style="max-width:24rem;white-space:normal">${escapeHtml(row.error_message)}</small>` : '';
  return `<span class="badge bg-${color}-lt text-${color}">● ${escapeHtml(label)}</span>${detail}`;
}

function formatInvoiceActions(_value, row) {
  if (['INCOMPLETE', 'READY_FOR_REVIEW'].includes(row.status)) {
    return `<div class="btn-list flex-nowrap"><a class="btn btn-sm btn-outline-primary" href="/invoice-correction.html?session=${encodeURIComponent(row.session_token)}">Tiếp tục</a><button class="btn btn-sm btn-outline-danger" data-action="cancel-session" data-token="${encodeURIComponent(row.session_token)}">Hủy</button></div>`;
  }
  if (['FAILED', 'RETRY_WAIT'].includes(row.status)) return `<div class="btn-list flex-nowrap"><button class="btn btn-sm btn-outline-primary" data-action="retry-session" data-token="${encodeURIComponent(row.session_token)}">Thử lại</button><button class="btn btn-sm btn-outline-danger" data-action="cancel-session" data-token="${encodeURIComponent(row.session_token)}">Hủy</button></div>`;
  if (['QUEUED', 'PROCESSING'].includes(row.status)) return `<button class="btn btn-sm btn-outline-danger" data-action="cancel-session" data-token="${encodeURIComponent(row.session_token)}">Hủy</button>`;
  if (row.status === 'PENDING_SYNC') return `<div class="btn-list flex-nowrap"><button class="btn btn-sm btn-primary" data-action="sync-invoice" data-id="${row.invoice_id}">Đồng bộ</button><a class="btn btn-sm btn-outline-primary" href="/invoice-detail.html?id=${row.invoice_id}">Xem</a><a class="btn btn-sm btn-outline-secondary" href="/invoice-edit.html?id=${row.invoice_id}">Sửa</a><button class="btn btn-sm btn-outline-danger" data-action="cancel-invoice" data-id="${row.invoice_id}">Hủy</button></div>`;
  return `<div class="btn-list flex-nowrap"><a class="btn btn-sm btn-outline-primary" href="/invoice-detail.html?id=${row.invoice_id}">Xem</a><a class="btn btn-sm btn-outline-secondary" href="/invoice-edit.html?id=${row.invoice_id}">Sửa</a></div>`;
}

function editAction(type, id) { return `<button class="btn btn-sm btn-outline-primary" data-action="edit-record" data-type="${type}" data-id="${id}">Chỉnh sửa</button>`; }

async function loadTable(pageName) {
  const config = pageConfigs[pageName];
  const target = document.querySelector('[data-table-content]');
  if (!config || !target) return;

  try {
    const filters = document.querySelector('#invoice-filters');
    const query = pageName === 'invoices' && filters ? new URLSearchParams(new FormData(filters)).toString() : '';
    const response = await fetch(`${config.endpoint}${query ? `?${query}` : ''}`);
    if (response.status === 401) return window.location.replace('/login.html');
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    const rows = await response.json();
    loadedTableName = pageName; loadedTableRows = rows;
    const header = config.columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('');
    const body = rows.length
      ? rows.map((row) => `<tr>${config.columns.map(([field, , formatter, html]) => {
        const value = formatter ? formatter(row[field], row) : row[field];
        return `<td>${html ? value : escapeHtml(value)}</td>`;
      }).join('')}</tr>`).join('')
      : `<tr><td colspan="${config.columns.length}" class="text-center text-secondary">Chưa có dữ liệu.</td></tr>`;

    const activeFilters = new URLSearchParams(query || location.search);
    const selectedStatus = activeFilters.get('status') || '';
    const invoiceFilters = pageName === 'invoices' ? `<form id="invoice-filters" class="card card-body mb-3"><div class="row g-2"><div class="col-md-4"><input class="form-control" name="q" value="${escapeHtml(activeFilters.get('q') || '')}" placeholder="Tìm số hóa đơn hoặc nhà cung cấp"></div><div class="col-md-2"><select class="form-select" name="status"><option value="">Tất cả trạng thái</option><option value="QUEUED" ${selectedStatus==='QUEUED'?'selected':''}>Chờ xử lý ảnh</option><option value="PROCESSING" ${selectedStatus==='PROCESSING'?'selected':''}>Đang xử lý ảnh</option><option value="RETRY_WAIT" ${selectedStatus==='RETRY_WAIT'?'selected':''}>Sẽ thử lại</option><option value="READY_FOR_REVIEW" ${['READY_FOR_REVIEW','INCOMPLETE'].includes(selectedStatus)?'selected':''}>Chờ kiểm tra</option><option value="FAILED" ${selectedStatus==='FAILED'?'selected':''}>Xử lý thất bại</option><option value="PENDING_SYNC" ${selectedStatus==='PENDING_SYNC'?'selected':''}>Chưa đồng bộ</option><option value="SYNCED" ${selectedStatus==='SYNCED'?'selected':''}>Đã hoàn thành</option></select></div><div class="col-md-2"><input class="form-control" name="dateFrom" type="date" value="${escapeHtml(activeFilters.get('dateFrom') || '')}" aria-label="Từ ngày"></div><div class="col-md-2"><input class="form-control" name="dateTo" type="date" value="${escapeHtml(activeFilters.get('dateTo') || '')}" aria-label="Đến ngày"></div><div class="col-md-2"><button class="btn btn-primary w-100">Lọc</button></div></div></form>` : '';
    target.innerHTML = `
      <div class="container-xl">
        ${invoiceFilters}
        <div id="table-feedback" class="mb-2" role="status"></div>
        <div class="card">
          <div class="table-responsive">
            <table class="table table-vcenter table-striped table-hover card-table">
              <thead><tr>${header}</tr></thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    document.querySelector('#invoice-filters')?.addEventListener('submit', (event) => { event.preventDefault(); loadTable('invoices'); });
    clearTimeout(invoiceRefreshTimer);
    if (pageName === 'invoices' && rows.some((row) => ['QUEUED','PROCESSING','RETRY_WAIT'].includes(row.status))) invoiceRefreshTimer = setTimeout(() => loadTable('invoices'), 5000);
  } catch (error) {
    console.error(error);
    target.innerHTML = `
      <div class="container-xl"><div class="alert alert-danger" role="alert">
        Không thể tải dữ liệu. Hãy kiểm tra máy chủ và kết nối PostgreSQL.
      </div></div>`;
  }
}

async function handleTableAction(event) {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  if (action === 'edit-record') { openEditModal(button.dataset.type, button.dataset.id); return; }
  if (action.startsWith('cancel') && !await SapiUI.confirmAction('Hủy hóa đơn này? Dữ liệu của hóa đơn hoặc phiên nhập chưa hoàn tất sẽ bị xóa.', { title: 'Hủy hóa đơn', confirmLabel: 'Hủy hóa đơn' })) return;
  const feedback = document.querySelector('#table-feedback'); const original = button.textContent; button.disabled = true;
  if (action === 'sync-invoice') button.textContent = 'Đang đồng bộ…';
  try {
    const sessionAction = ['cancel-session','retry-session'].includes(action);
    const url = sessionAction ? `/api/invoice-sessions/${button.dataset.token}${action === 'retry-session' ? '/process' : ''}` : `/api/invoices/${button.dataset.id}${action === 'sync-invoice' ? '/sync' : ''}`;
    const response = await fetch(url, { method: ['sync-invoice','retry-session'].includes(action) ? 'POST' : 'DELETE' });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Không thể thực hiện thao tác.');
    SapiUI.notify(action === 'sync-invoice' ? 'Đồng bộ hóa đơn thành công.' : action === 'retry-session' ? 'Đã đưa hóa đơn trở lại hàng đợi.' : 'Đã hủy hóa đơn.');
    await loadTable('invoices');
  } catch (error) {
    if (feedback) { feedback.className = 'alert alert-danger mb-2'; feedback.textContent = error.message; }
    button.disabled = false; button.textContent = original;
  }
}

function ensureEditModal() {
  if (document.querySelector('#edit-record-modal')) return;
  document.body.insertAdjacentHTML('beforeend', `<div id="edit-record-modal-backdrop" class="modal-backdrop fade show d-none"></div><div id="edit-record-modal" class="modal d-none" style="display:none" aria-hidden="true"><div class="modal-dialog modal-dialog-centered"><form id="edit-record-form" class="modal-content"><div class="modal-header"><h3 id="edit-record-title" class="modal-title"></h3><button type="button" class="btn-close" data-close-modal="edit-record-modal"></button></div><div id="edit-record-fields" class="modal-body"></div><div class="modal-footer"><button type="button" class="btn" data-close-modal="edit-record-modal">Hủy</button><button id="edit-record-save" class="btn btn-primary" type="submit">Lưu</button></div></form></div></div>`);
  document.querySelectorAll('#edit-record-modal [data-close-modal]').forEach((button) => button.addEventListener('click', () => toggleModal('edit-record-modal', false)));
  document.querySelector('#edit-record-form').addEventListener('submit', saveEditedRecord);
}

function openEditModal(type, id) {
  ensureEditModal(); const config = editConfigs[type]; const row = loadedTableRows.find((item) => String(item[config.id]) === String(id)); if (!row) return;
  const form = document.querySelector('#edit-record-form'); form.dataset.type = type; form.dataset.id = id; document.querySelector('#edit-record-title').textContent = config.title;
  document.querySelector('#edit-record-fields').innerHTML = config.fields.map(([payloadKey,rowKey,label,inputType]) => `<div class="mb-3"><label class="form-label" for="edit-${payloadKey}">${label}</label><input id="edit-${payloadKey}" name="${payloadKey}" class="form-control" type="${inputType||'text'}" ${inputType==='number'?'min="0" step="0.01"':''} value="${escapeHtml(row[rowKey] ?? '')}"></div>`).join('');
  toggleModal('edit-record-modal', true);
}

async function saveEditedRecord(event) {
  event.preventDefault(); const form = event.currentTarget; const config = editConfigs[form.dataset.type]; const button = document.querySelector('#edit-record-save'); button.disabled = true; button.textContent = 'Đang lưu…';
  let feedback = document.querySelector('#edit-record-feedback');
  if (!feedback) { feedback = document.createElement('div'); feedback.id = 'edit-record-feedback'; form.querySelector('.modal-body').append(feedback); }
  feedback.textContent = '';
  try { const body = Object.fromEntries(new FormData(form).entries()); await jsonRequest(`${config.endpoint}/${form.dataset.id}`, { method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) }); toggleModal('edit-record-modal', false); await loadTable(loadedTableName); SapiUI.notify('Đã lưu dữ liệu đối chiếu.'); }
  catch(error){ feedback.className = 'alert alert-danger'; feedback.setAttribute('role','alert'); feedback.textContent = error.message; } finally { button.disabled=false; button.textContent='Lưu'; }
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) { location.replace('/login.html'); throw new Error('Bạn cần đăng nhập.'); }
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error || 'Không thể xử lý yêu cầu.'); error.code = payload.code; error.status = response.status; throw error; }
  return payload;
}

const modalOpeners = new WeakMap();
function toggleModal(id, show) {
  const modal = document.querySelector(`#${id}`); const backdrop = document.querySelector(`#${id}-backdrop`); if (!modal) return;
  if (show) modalOpeners.set(modal, document.activeElement);
  modal.classList.toggle('d-none', !show); modal.style.display = show ? 'block' : 'none'; modal.setAttribute('aria-hidden', String(!show)); backdrop?.classList.toggle('d-none', !show);
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.tabIndex = -1;
  const title = modal.querySelector('.modal-title'); if (title) { title.id ||= `${id}-title`; modal.setAttribute('aria-labelledby', title.id); }
  if (show) (modal.querySelector('input:not([disabled]),select,button') || modal).focus();
  else {
    if (id === 'settings-modal') { document.querySelector('#password-form')?.reset(); const message = document.querySelector('#password-message'); if (message) { message.replaceChildren(); message.className = ''; } }
    modalOpeners.get(modal)?.focus();
  }
}

document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]')) return;
  const modal = [...document.querySelectorAll('.modal[aria-hidden="false"]')].at(-1); if (!modal) return;
  if (event.key === 'Escape') { event.preventDefault(); toggleModal(modal.id, false); }
  if (event.key === 'Tab') {
    const controls = [...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter((element) => !element.disabled && element.getClientRects().length);
    if (!controls.length) { event.preventDefault(); modal.focus(); return; }
    if (event.shiftKey && (document.activeElement === controls[0] || !modal.contains(document.activeElement))) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && (document.activeElement === controls.at(-1) || !modal.contains(document.activeElement))) { event.preventDefault(); controls[0].focus(); }
  }
});

function initializeSettings() {
  document.querySelector('#settings-modal .modal-dialog').classList.add('modal-dialog-scrollable');
  const body = document.querySelector('#settings-modal .modal-body');
  body.classList.remove('text-secondary');
  body.innerHTML = `<section aria-labelledby="display-settings"><h4 id="display-settings">Hiển thị</h4><label class="form-label" for="font-size">Cỡ chữ</label><div class="d-flex gap-2"><select id="font-size" class="form-select"><option value="small">Nhỏ</option><option value="default">Mặc định</option><option value="large">Lớn</option></select><button id="reset-font-size" type="button" class="btn">Mặc định</button></div><p class="form-hint mt-2">Áp dụng ngay và lưu trên trình duyệt này.</p></section><hr><section aria-labelledby="password-settings"><h4 id="password-settings">Đổi mật khẩu</h4><form id="password-form"><label class="form-label" for="current-password">Mật khẩu hiện tại</label><input id="current-password" name="currentPassword" class="form-control mb-3" type="password" autocomplete="current-password" required><label class="form-label" for="new-password">Mật khẩu mới</label><input id="new-password" name="newPassword" class="form-control mb-3" type="password" autocomplete="new-password" minlength="8" required><label class="form-label" for="confirm-password">Xác nhận mật khẩu mới</label><input id="confirm-password" name="confirmPassword" class="form-control" type="password" autocomplete="new-password" minlength="8" required><p class="form-hint mt-2">Ít nhất 8 ký tự, tối đa 72 byte. Sau khi đổi, các phiên khác sẽ đăng xuất; phiên này được giữ.</p><div id="password-message" aria-live="polite"></div><button id="save-password" type="submit" class="btn btn-primary">Đổi mật khẩu</button></form></section>`;
  const select = document.querySelector('#font-size'); select.value = document.documentElement.dataset.fontSize;
  function updateFont(value) { select.value = value; if (!SapiUI.setFontSize(value)) SapiUI.notify('Đã đổi cỡ chữ nhưng trình duyệt không cho lưu lựa chọn.', 'warning'); }
  select.addEventListener('change', () => updateFont(select.value));
  document.querySelector('#reset-font-size').addEventListener('click', () => updateFont('default'));
  document.querySelector('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; const button = document.querySelector('#save-password'); const message = document.querySelector('#password-message');
    const data = Object.fromEntries(new FormData(form)); message.textContent = '';
    if (data.newPassword !== data.confirmPassword) { message.className = 'alert alert-danger'; message.textContent = 'Xác nhận mật khẩu mới không trùng khớp.'; return; }
    button.disabled = true; button.textContent = 'Đang đổi mật khẩu…';
    try { const result = await jsonRequest('/api/auth/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); form.reset(); message.className = 'alert alert-success'; message.textContent = result.message; SapiUI.notify('Đã đổi mật khẩu.'); }
    catch (error) { message.className = 'alert alert-danger'; message.textContent = error.message; }
    finally { button.disabled = false; button.textContent = 'Đổi mật khẩu'; }
  });
}

async function initializeSharedNavigation() {
  const account = await jsonRequest('/api/auth/me');
  const pageRoot = document.querySelector('.page') || document.body;
  Array.from(pageRoot.children).filter((node) => node.tagName === 'HEADER').forEach((header) => header.remove());
  const page = location.pathname.split('/').pop() || 'index.html';
  const links = [['index.html', 'Nhập hàng'], ['products.html', 'Hàng hóa'], ['suppliers.html', 'Nhà cung cấp'], ['data.html', 'Dữ liệu đối chiếu']];
  pageRoot.insertAdjacentHTML('afterbegin', `<header class="navbar navbar-expand-md d-print-none"><div class="container-xl"><a class="navbar-brand fw-bold fs-2 text-primary" href="/index.html">SAPI</a><div class="ms-auto d-flex flex-wrap align-items-center justify-content-end gap-3"><div id="connection-status" class="small"></div><button id="edit-connections" class="btn btn-sm">Sửa thông tin</button><div><button id="navbar-sync" class="btn btn-sm btn-outline-primary">Đồng bộ ngay</button><div id="navbar-feedback" class="small text-end mt-1" style="white-space:pre-line"></div></div><span class="text-secondary">Xin chào, ${escapeHtml(account.user.username)}</span><button data-logout class="btn btn-sm btn-outline-secondary">Đăng xuất</button></div></div></header><header class="navbar-expand-md border-bottom"><div class="navbar"><div class="container-xl"><ul class="navbar-nav">${links.map(([href,label])=>`<li class="nav-item ${page===href?'active':''}"><a class="nav-link" href="/${href}"><span class="nav-link-title">${label}</span></a></li>`).join('')}</ul><button id="settings-icon" class="btn btn-icon btn-ghost-secondary ms-auto" type="button" aria-label="Cài đặt">⚙</button></div></div></header>`);
  document.body.insertAdjacentHTML('beforeend', `<div id="settings-modal-backdrop" class="modal-backdrop fade show d-none"></div><div id="settings-modal" class="modal d-none" style="display:none" aria-hidden="true"><div class="modal-dialog modal-dialog-centered"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">Cài đặt</h3><button class="btn-close" data-close-modal="settings-modal"></button></div><div class="modal-body text-secondary">Nội dung sẽ được bổ sung sau.</div><div class="modal-footer"><button class="btn" data-close-modal="settings-modal">Đóng</button></div></div></div></div>
  <div id="connections-modal-backdrop" class="modal-backdrop fade show d-none"></div><div id="connections-modal" class="modal d-none" style="display:none" aria-hidden="true"><div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable"><div class="modal-content"><div class="modal-header"><h3 class="modal-title">Sửa thông tin</h3><button class="btn-close" data-close-modal="connections-modal"></button></div><div class="modal-body">
    <div class="d-flex justify-content-between"><h3>1. Thông tin cửa hàng</h3><button id="store-edit" class="btn btn-sm">Sửa</button></div><p class="text-secondary">Thông tin này giúp SAPI phân biệt người mua với nhà cung cấp khi đọc hóa đơn.</p><dl id="store-view" class="row mb-0"></dl><div id="store-form"><div class="row"><div class="col-md-6 mb-3"><label class="form-label">Tên cửa hàng</label><input id="store-name" class="form-control"></div><div class="col-md-6 mb-3"><label class="form-label">Mã số thuế</label><input id="store-tax-code" class="form-control"></div><div class="col-12 mb-3"><label class="form-label">Địa chỉ</label><input id="store-address" class="form-control"></div><div class="col-md-6 mb-3"><label class="form-label">Số điện thoại</label><input id="store-phone" class="form-control"></div><div class="col-md-6 mb-3"><label class="form-label">Email</label><input id="store-email" class="form-control" type="email"></div></div><div class="btn-list"><button id="store-cancel" class="btn btn-sm">Hủy</button><button id="store-save" class="btn btn-primary btn-sm">Lưu</button></div></div><div id="store-message" class="small mt-2" style="white-space:pre-line"></div><hr>
    <div class="d-flex justify-content-between"><h3>2. KiotViet</h3><button id="kiot-edit" class="btn btn-sm">Sửa</button></div><div id="kiot-view"><div id="edit-kiot-status" class="small mb-3"></div><div class="btn-list"><button id="kiot-check" class="btn btn-outline-primary btn-sm">Kiểm tra kết nối</button><button id="kiot-disconnect" class="btn btn-outline-danger btn-sm">Ngắt kết nối</button></div></div><div id="kiot-form"><div class="row"><div class="col-md-6 mb-3"><label class="form-label">Client ID</label><input id="kiot-client-id" class="form-control" autocomplete="off"></div><div class="col-md-6 mb-3"><label class="form-label">Mã bảo mật</label><input id="kiot-client-secret" class="form-control" type="password" autocomplete="new-password" placeholder="Nhập mã mới; mã đã lưu không được hiển thị"></div><div class="col-12 mb-3"><label class="form-label">Retailer/gian hàng</label><input id="kiot-retailer" class="form-control" placeholder="abc hoặc abc.kiotviet.vn"></div></div><label id="kiot-dev-wrap" class="form-check d-none"><input id="kiot-use-dev" class="form-check-input" type="checkbox"><span class="form-check-label">Sử dụng thông tin KiotViet từ môi trường development</span></label><a class="small d-block mt-2" href="/huong-dan-ket-noi-kiotviet" target="_blank" rel="noopener">Cách lấy thông tin API KiotViet ↗</a><div class="btn-list mt-3"><button id="kiot-cancel" class="btn btn-sm">Hủy</button><button id="kiot-connect" class="btn btn-primary btn-sm">Kết nối / Cập nhật</button></div></div><div id="kiot-message" class="small mt-2" style="white-space:pre-line"></div><hr>
    <div id="sync-schedule" class="mt-3"><label class="form-check"><input id="sync-enabled" class="form-check-input" type="checkbox"><span class="form-check-label">Tự động đồng bộ KiotViet</span></label><div class="row g-2 align-items-end mt-1"><div class="col-sm-5"><label class="form-label">Chu kỳ (phút)</label><input id="sync-interval" class="form-control" type="number" min="15" max="1440" value="60"></div><div class="col-sm-4"><button id="sync-schedule-save" class="btn btn-outline-primary">Lưu lịch</button></div></div><div id="sync-schedule-status" class="small text-secondary mt-2"></div></div><hr>
    <div class="d-flex justify-content-between"><h3>3. Gemini API</h3><button id="gemini-edit" class="btn btn-sm">Sửa</button></div><div id="gemini-view"><div id="gemini-status" class="small mb-2"></div></div><div id="gemini-form"><label class="form-label" for="gemini-api-key">Gemini API Key</label><input id="gemini-api-key" class="form-control" type="password" autocomplete="new-password" placeholder="Nhập key mới; key đã lưu không được hiển thị"><div class="mt-3 mb-2"><label class="form-label" for="gemini-host">API host</label><input id="gemini-host" type="url" class="form-control" value="https://generativelanguage.googleapis.com"><div class="form-hint">Mặc định Google AI Studio. Host HTTPS gốc, không thêm /v1.</div></div><a class="small d-block mt-2" href="/huong-dan-ket-noi-gemini" target="_blank" rel="noopener">Cách lấy Gemini API Key ↗</a><div class="btn-list mt-3"><button id="gemini-cancel" class="btn btn-sm">Hủy</button><button id="gemini-connect" class="btn btn-sm btn-primary">Kiểm tra và lưu API Key</button></div></div><div id="gemini-message" class="small mt-2" style="white-space:pre-line"></div>
  </div><div class="modal-footer"><button class="btn" data-close-modal="connections-modal">Đóng</button></div></div></div></div>`);
  let connectionState = { kiot: {}, gemini: {} }; let currentProfile = {};
  const formatConnectionDate = (value) => value ? new Intl.DateTimeFormat('vi-VN', { dateStyle:'short', timeStyle:'short' }).format(new Date(value)) : 'Chưa có';
  const showMessage = (id, message, success = false) => { const target=document.querySelector(id); target.className=`small mt-2 text-${success?'success':'danger'}`; target.setAttribute('role', success ? 'status' : 'alert'); target.textContent=message; if (success) SapiUI.notify(message); };
  function setSectionMode(section, editing, configured) {
    document.querySelector(`#${section}-view`).classList.toggle('d-none', editing || !configured);
    document.querySelector(`#${section}-form`).classList.toggle('d-none', !editing && configured);
    document.querySelector(`#${section}-edit`).classList.toggle('d-none', editing || !configured);
    document.querySelector(`#${section}-cancel`).classList.toggle('d-none', !configured);
  }
  function renderStoreProfile(profile) {
    currentProfile = profile; const configured=Object.values(profile).some(Boolean);
    const rows=[['Tên cửa hàng',profile.store_name],['Mã số thuế',profile.tax_code],['Địa chỉ',profile.address],['Số điện thoại',profile.phone],['Email',profile.email]];
    document.querySelector('#store-view').innerHTML=rows.map(([label,value])=>`<dt class="col-sm-4">${label}</dt><dd class="col-sm-8">${escapeHtml(value || '—')}</dd>`).join('');
    [['#store-name','store_name'],['#store-tax-code','tax_code'],['#store-address','address'],['#store-phone','phone'],['#store-email','email']].forEach(([selector,key])=>{document.querySelector(selector).value=profile[key] || ''});
    setSectionMode('store', false, configured);
  }
  async function refreshConnections() {
    const [kiot, gemini] = await Promise.all([jsonRequest('/api/integrations/kiotviet/status'), jsonRequest('/api/integrations/gemini/status')]);
    connectionState = { kiot, gemini };
    const status = document.querySelector('#connection-status');
    const kiotMode = kiot.mode === 'mock' ? 'Mock API' : 'Live API';
    status.innerHTML = `<div class="${kiot.connected?'text-success':'text-secondary'}">● KiotViet${kiot.mode==='mock'?' (Mock)':''} &nbsp; ${kiot.connected?'Đã kết nối':'Chưa kết nối'}</div><div class="${gemini.connected?'text-success':'text-secondary'}">● Gemini &nbsp; ${gemini.connected?'Đã kết nối':'Chưa cấu hình'}</div>`;
    document.querySelector('#edit-kiot-status').innerHTML = kiot.connected ? `<span class="text-success">● Đã kết nối</span><br>Chế độ: ${kiotMode}<br>Gian hàng: ${escapeHtml(kiot.retailerName || kiot.retailerCode)}<br>Đồng bộ lần cuối: ${escapeHtml(formatConnectionDate(kiot.lastSyncAt))}` : `<span class="text-secondary">● Chưa kết nối</span><br>Chế độ: ${kiotMode}`;
    document.querySelector('#kiot-retailer').value = kiot.retailerCode || '';
    document.querySelector('#kiot-check').classList.toggle('d-none', !kiot.connected);
    document.querySelector('#kiot-disconnect').classList.toggle('d-none', !kiot.connected);
    document.querySelector('#kiot-dev-wrap').classList.toggle('d-none', !kiot.devCredentialsAvailable);
    const schedule = kiot.automaticSync || {};
    document.querySelector('#sync-enabled').checked = Boolean(schedule.enabled);
    document.querySelector('#sync-interval').value = schedule.intervalMinutes || 60;
    document.querySelector('#sync-schedule').classList.toggle('d-none', !kiot.connected);
    document.querySelector('#sync-schedule-status').textContent = schedule.enabled ? `Lần chạy kế tiếp: ${formatConnectionDate(schedule.nextSyncAt)}${schedule.lastError ? ` · Lỗi gần nhất: ${schedule.lastError}` : ''}` : 'Đang tắt. Đồng bộ vẫn có thể thực hiện thủ công.';
    document.querySelector('#gemini-status').textContent = gemini.connected ? `● Đã cấu hình${gemini.baseUrl ? ` · ${gemini.baseUrl}` : ''}` : gemini.error || '● Chưa cấu hình';
    document.querySelector('#gemini-status').className = `small mb-2 text-${gemini.connected?'success':'secondary'}`;
    document.querySelector('#gemini-host').value = gemini.source === 'stored' && gemini.baseUrl ? gemini.baseUrl : 'https://generativelanguage.googleapis.com';
    setSectionMode('kiot', false, kiot.connected); setSectionMode('gemini', false, gemini.connected);
  }
  async function openInformationModal() {
    const profile = await jsonRequest('/api/auth/profile');
    renderStoreProfile(profile);
    document.querySelector('#store-message').textContent=''; document.querySelector('#kiot-message').textContent=''; document.querySelector('#gemini-message').textContent='';
    await refreshConnections(); toggleModal('connections-modal', true);
  }
  initializeSettings();
  document.addEventListener('sapi:connections-changed', () => refreshConnections().catch((error) => SapiUI.notify(error.message, 'danger')));
  document.querySelector('[data-logout]').addEventListener('click', async () => { try { await jsonRequest('/api/auth/logout', { method: 'POST' }); location.replace('/login.html'); } catch (error) { SapiUI.notify(error.message, 'danger'); } });
  document.querySelector('#settings-icon').addEventListener('click', () => toggleModal('settings-modal', true));
  document.querySelector('#edit-connections').addEventListener('click', () => openInformationModal().catch((error) => SapiUI.notify(error.message, 'danger')));
  document.querySelectorAll('[data-close-modal]').forEach((button) => { button.setAttribute('aria-label', 'Đóng'); button.addEventListener('click', () => toggleModal(button.dataset.closeModal, false)); });
  document.querySelector('#store-edit').addEventListener('click',()=>setSectionMode('store',true,true));
  document.querySelector('#store-cancel').addEventListener('click',()=>renderStoreProfile(currentProfile));
  document.querySelector('#store-save').addEventListener('click', async () => {
    const button=document.querySelector('#store-save'); button.disabled=true;
    try { const saved=await jsonRequest('/api/auth/profile',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({storeName:document.querySelector('#store-name').value,taxCode:document.querySelector('#store-tax-code').value,address:document.querySelector('#store-address').value,phone:document.querySelector('#store-phone').value,email:document.querySelector('#store-email').value})}); renderStoreProfile(saved); showMessage('#store-message','✓ Đã lưu thông tin cửa hàng.',true); }
    catch(error){showMessage('#store-message',error.message)} finally{button.disabled=false}
  });
  document.querySelector('#navbar-sync').addEventListener('click', async () => {
    const button = document.querySelector('#navbar-sync'); const feedback = document.querySelector('#navbar-feedback'); button.disabled=true; button.textContent='Đang đồng bộ...'; feedback.textContent='';
    try { await jsonRequest('/api/integrations/kiotviet/sync',{method:'POST'}); feedback.className='small text-end mt-1 text-success'; feedback.textContent='✓ Đồng bộ thành công'; SapiUI.notify('Đồng bộ danh mục KiotViet thành công.'); await refreshConnections(); }
    catch(error){ feedback.className='small text-end mt-1 text-danger'; feedback.textContent=error.message; }
    finally{ button.disabled=false; button.textContent='Đồng bộ ngay'; }
  });
  document.querySelector('#kiot-use-dev').addEventListener('change', (event) => { ['#kiot-client-id','#kiot-client-secret','#kiot-retailer'].forEach((selector)=>{document.querySelector(selector).disabled=event.target.checked}); });
  document.querySelector('#kiot-edit').addEventListener('click',()=>setSectionMode('kiot',true,true));
  document.querySelector('#kiot-cancel').addEventListener('click',()=>{document.querySelector('#kiot-client-id').value='';document.querySelector('#kiot-client-secret').value='';document.querySelector('#kiot-retailer').value=connectionState.kiot.retailerCode || '';setSectionMode('kiot',false,connectionState.kiot.connected)});
  document.querySelector('#kiot-connect').addEventListener('click', async () => {
    const button=document.querySelector('#kiot-connect'); button.disabled=true; button.textContent='Đang kiểm tra…';
    try { const useDevCredentials=document.querySelector('#kiot-use-dev').checked; await jsonRequest('/api/integrations/kiotviet/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(useDevCredentials?{useDevCredentials:true}:{clientId:document.querySelector('#kiot-client-id').value,clientSecret:document.querySelector('#kiot-client-secret').value,retailer:document.querySelector('#kiot-retailer').value})}); document.querySelector('#kiot-client-id').value='';document.querySelector('#kiot-client-secret').value=''; showMessage('#kiot-message','✓ Kết nối KiotViet thành công.',true); await refreshConnections(); }
    catch(error){showMessage('#kiot-message',error.message)} finally{button.disabled=false;button.textContent='Kết nối / Cập nhật'}
  });
  document.querySelector('#kiot-check').addEventListener('click', async () => { try{await jsonRequest('/api/integrations/kiotviet/check',{method:'POST'});showMessage('#kiot-message','✓ Kết nối KiotViet đang hoạt động.',true);await refreshConnections()}catch(error){showMessage('#kiot-message',error.message)} });
  document.querySelector('#kiot-disconnect').addEventListener('click', async () => { if(!await SapiUI.confirmAction('SAPI sẽ không thể đồng bộ danh mục hoặc gửi phiếu nhập cho đến khi bạn kết nối lại.', { title: 'Ngắt kết nối KiotViet', confirmLabel: 'Ngắt kết nối' }))return;try{await jsonRequest('/api/integrations/kiotviet/disconnect',{method:'POST'});showMessage('#kiot-message','Đã ngắt kết nối KiotViet.',true);await refreshConnections()}catch(error){showMessage('#kiot-message',error.message)} });
  document.querySelector('#sync-schedule-save').addEventListener('click', async () => { const button=document.querySelector('#sync-schedule-save'); button.disabled=true; try { await jsonRequest('/api/integrations/kiotviet/schedule',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:document.querySelector('#sync-enabled').checked,intervalMinutes:Number(document.querySelector('#sync-interval').value)})}); await refreshConnections(); } catch(error) { document.querySelector('#sync-schedule-status').textContent=error.message; } finally { button.disabled=false; } });
  document.querySelector('#gemini-edit').addEventListener('click',()=>setSectionMode('gemini',true,true));
  document.querySelector('#gemini-cancel').addEventListener('click',()=>{document.querySelector('#gemini-api-key').value='';document.querySelector('#gemini-host').value=connectionState.gemini.baseUrl || 'https://generativelanguage.googleapis.com';setSectionMode('gemini',false,connectionState.gemini.connected)});
  document.querySelector('#gemini-connect').addEventListener('click', async () => {
    const button=document.querySelector('#gemini-connect'); const message=document.querySelector('#gemini-message'); button.disabled=true; button.textContent='Đang kiểm tra...';
    try { await jsonRequest('/api/integrations/gemini/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:document.querySelector('#gemini-api-key').value,baseUrl:document.querySelector('#gemini-host').value.trim()})}); message.className='small mt-2 text-success';message.textContent='✓ Đã lưu Gemini API';SapiUI.notify('Đã lưu kết nối Gemini.');document.querySelector('#gemini-api-key').value='';await refreshConnections(); }
    catch(error){message.className='small mt-2 text-danger';message.textContent=error.message}finally{button.disabled=false;button.textContent='Lưu Gemini API'}
  });
  try { await refreshConnections(); } catch (error) { SapiUI.notify(error.message, 'danger'); }
}

document.addEventListener('DOMContentLoaded', async () => {
  try { await initializeSharedNavigation(); } catch (error) { console.warn(error.message); }
  document.addEventListener('click', handleTableAction);
  try {
    const bulkNotice = sessionStorage.getItem('sapi.bulkNotice');
    if (bulkNotice) { sessionStorage.removeItem('sapi.bulkNotice'); SapiUI.notify(bulkNotice); }
  } catch (error) { console.warn('Không thể đọc thông báo phiên hàng loạt:', error.message); }
});
