# SAPI

Local web app for importing multi-page purchase invoices with Gemini OCR, account-scoped product/supplier mapping, and the existing KiotViet synchronization endpoints.

## Authentication and first-time setup

- On first start, open `http://localhost:3000/login.html` and create the first account. Its password is stored only as a bcrypt hash.
- The first account claims legacy supplier, product, and purchase-invoice rows that do not yet have an owner.
- All dashboard pages and business APIs require the authenticated session cookie. The tokenized mobile upload page is the only login-free workflow.
- Set a stable, long random `SESSION_SECRET` in `backend/.env`. Use `COOKIE_SECURE=true` when deployed behind HTTPS.
- Set `BASE_URL` to the address phones can reach. For a LAN demo this is normally `http://<host-lan-ip>:3000`; for deployment use the public HTTPS origin.

## Requirements

- Node.js (npm)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
- One real invoice image for the test button
- PostgreSQL is used by the list pages (Nhập hàng, Hàng hóa, …). The Gemini test flow does **not** write invoices to the database. Mapping lookup is optional: if PostgreSQL is down, extraction still works and **Thông tin tương ứng** stays empty.

## Run from scratch

Do this on a clean machine (or after cloning the repo). One Node process serves both API and frontend. There is no separate frontend install.

1. Install [Node.js](https://nodejs.org/) (includes `npm`).
2. Open a terminal in the **project root** (the folder that contains `backend/` and `frontend/`).
3. Create env file and set the Gemini key (required for extraction):

   ```powershell
   copy backend\.env.example backend\.env
   ```

   Edit `backend/.env` and set one API key from [Google AI Studio](https://aistudio.google.com/app/apikey). Do not put the key in source files or frontend code.

   | Variable | Required for Gemini test? | Notes |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | Yes | API key dùng để đọc hóa đơn; chỉ lưu trong `backend/.env` |
   | `GEMINI_BASE_URL` | No | Mặc định `https://generativelanguage.googleapis.com`; mỗi cấu hình chỉ dùng một key với một host |
   | `GEMINI_MODEL` | No | Recommended `gemini-3.8-flash` |
   | `GEMINI_FALLBACK_MODEL` | No | Recommended `gemini-3.6-flash`; keep a genuinely different model available to the key |
   | `GEMINI_TIMEOUT_MS` | No | Default `120000` (2 minutes). Vision extraction often exceeds 30s. |
   | `GEMINI_PROMPT_VERSION` | No | `compact` by default; `detailed` selects the retained full prompt |
   | `GEMINI_PROMPT_FALLBACK_ON_INVALID` | No | With `compact`, retry once using `detailed` only for an empty/invalid/schema-invalid response |
   | `GEMINI_VERIFY_SUSPICIOUS` | No | Mặc định `true`; chỉ đọc kiểm chứng lần hai khi phát hiện lệch cột hoặc mâu thuẫn số học |
   | `PORT` | No | Default `3000` |
   | `DB_*` | No | Only for list pages / optional mapping lookup |

4. Test image: this repo already has `backend/test_images/01.jfif`. If you start from empty folders, add a file named `01` plus its real extension under `backend/test_images/` or `test_images/` (`.jpg`, `.jpeg`, `.jfif`, `.png`, `.webp`).
5. Install and start:

   ```powershell
   cd backend
   npm.cmd install
   npm.cmd start
   ```

   Auto-reload while editing server files: `npm.cmd run dev`.
6. Open `http://localhost:3000` → **Bắt đầu phiên nhập hàng** → **Upload ảnh**.

Stop the server with Ctrl+C in that terminal. If port 3000 is already in use, stop the old Node process or change `PORT` in `backend/.env`.

### Upload ảnh hàng loạt

- Trên trang **Nhập hàng**, chọn **Upload ảnh hàng loạt**. Trong phiên bản này, mỗi ảnh tương ứng một hóa đơn riêng; hóa đơn nhiều trang vẫn dùng luồng upload thông thường.
- Có thể chọn tối đa 20 ảnh. Sau khi bấm **Tạo phiên xử lý**, trình duyệt quay ngay về danh sách và backend xử lý lần lượt từng hóa đơn.
- Trạng thái được cập nhật theo thứ tự **Chờ xử lý ảnh** → **Đang xử lý ảnh** → **Chờ kiểm tra**. Lỗi tạm thời chuyển sang **Tạm hoãn, sẽ thử lại** để ảnh khác không bị chặn.
- Khi hoàn tất, chọn **Tiếp tục** để mở trực tiếp màn hình sửa hóa đơn. Chế độ hàng loạt không tự xác nhận hóa đơn và không tự gửi dữ liệu sang KiotViet.
- Hàng đợi nằm trong PostgreSQL và được tiếp tục sau khi backend khởi động lại. `INVOICE_OCR_QUEUE_TICK_MS` và `INVOICE_OCR_MAX_ATTEMPTS` lần lượt điều chỉnh chu kỳ kiểm tra và số lần thử tối đa.

**PowerShell:** if `npm start` fails with “running scripts is disabled”, use `npm.cmd start` (and `npm.cmd install`) instead of `npm`. Run those commands inside `backend`, not the project root.

**After any change to `backend/.env` you must restart the server.** `dotenv` only reads the file at process start. Ctrl+C, then `npm.cmd start` again. Filling the key while Node is already running has no effect.

### Cấu hình Gemini

Trong triển khai thực tế, mỗi cấu hình SAPI dùng đúng **một API key và một API host**. Mặc định host là Google AI Studio:

```dotenv
GEMINI_API_KEY=your-google-ai-studio-key
GEMINI_BASE_URL=https://generativelanguage.googleapis.com
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODEL=gemini-3.6-flash
GEMINI_TIMEOUT_MS=120000
```

Đặt key thật chỉ trong `backend/.env`, file đã được gitignore. Không thêm `/v1` vào URL của Google GenAI SDK. Sau khi đổi key, host hoặc model, phải restart backend.

Người dùng cũng có thể nhập key và host trong màn hình **Sửa thông tin → Gemini API**. Host mặc định vẫn là Google AI Studio; key và host đã lưu được mã hóa trong database và không được trả lại frontend. Một tài khoản tại một thời điểm chỉ sử dụng một cặp key/host đã chọn.

Model chính và model dự phòng dùng chung cặp key/host, được cấu hình qua `GEMINI_MODEL` và `GEMINI_FALLBACK_MODEL`. Nếu key không được cấp quyền dùng model đã chọn, SAPI sẽ báo lỗi để người dùng kiểm tra lại cấu hình.

Hai prompt được giữ trong `backend/services/geminiInvoicePrompt.js`: `compact` là bản ngắn mặc định và `detailed` là bản đầy đủ. Cả hai giữ nguyên quy tắc đơn vị/quy cách. Fallback prompt chỉ kích hoạt khi response rỗng, JSON lỗi hoặc sai schema; backend không thể tự phát hiện một giá trị sai về nghiệp vụ nhưng vẫn hợp lệ về schema, nên các trường hợp đó vẫn cần người dùng kiểm tra hoặc thực nghiệm A/B.

Kiểm thử cấu hình offline, không gửi ảnh hay trừ credit: `cd backend`, rồi `npm.cmd run test:gemini-config`.

Kiểm tra kết nối thật (gửi một yêu cầu văn bản ngắn, có thể tính credit): `node scripts/test-gemini-connection.js`. Để áp dụng key `.env` cho tài khoản đã tồn tại, chạy `node scripts/test-gemini-connection.js --connect-user 12` (thay 12 bằng đúng user_id). Lệnh này chỉ thay cấu hình kết nối Gemini sau khi kiểm tra thành công, không tạo hóa đơn hoặc mapping. Không truyền key qua command line.

## Multi-page invoice flow

1. **Nhập hàng** → **Bắt đầu nhập phiên hóa đơn**.
2. Select one or more images on the PC and click **Upload**, or scan the QR and send multiple pages from a phone.
3. Add all pages to the same session, then click **Gửi ảnh**. Only this action starts Gemini.
4. The backend sends all pages in order as one invoice and stores the standardized JSON as intermediate `ocr_result`:

```json
{
  "supplier": { "name": null, "phone": null, "address": null, "tax_code": null },
  "invoice": { "number": null, "date": null },
    "items": [{ "name": null, "quantity": null, "unit": null, "package_quantity": null, "package_unit": null, "unit_price": null, "price_unit": null, "total_price": null, "line_type": "PRODUCT", "line_status": "ACTIVE", "status_reason": null }],
    "promotions": [],
  "total_amount": null
}
```

5. The application scopes supplier/product mapping to the logged-in account. Product autocomplete searches product names, codes, and external names with a debounce.
6. **Sửa hóa đơn** giữ riêng JSON OCR gốc và dữ liệu đã qua kiểm tra để sử dụng. Schema giữ các cột số lượng thô (ví dụ `Thùng`/`Lẻ`); backend kiểm tra quan hệ số lượng–quy cách–đơn giá–thành tiền. Khi phát hiện nghi vấn, hệ thống đọc kiểm chứng lần hai và chỉ áp dụng chuẩn hóa nếu hai lượt nhất quán; nếu khác nhau thì giữ lượt đầu và cảnh báo người dùng. Dòng `CANCELLED` bị loại khỏi nhập hàng; dòng `UNCERTAIN` được tô cảnh báo.
7. Only **Xác nhận hóa đơn** creates `purchaseinvoice` and `purchaseinvoiceitem`, updates mapping where applicable, marks the session confirmed, and deletes temporary image files.

### Mapping and KiotViet source of truth

- Gemini only reads the text printed on the invoice. It never chooses a KiotViet product or supplier.
- SAPI only auto-fills a product/supplier when an exact mapping confirmed by the user exists for that supplier and printed name.
- If no mapping exists, choose a product and supplier from the synchronized KiotViet catalog. On confirmation, SAPI saves the exact mapping for later invoices.
- Product and supplier master data are read-only in SAPI. Create or correct them in KiotViet, then use **Đồng bộ ngay**.
- Before sending images to Gemini, the upload page can remove a saved page and move pages up/down. These operations are locked once Gemini processing starts.

### Invoice search, correction, and retry

- The Nhập hàng list supports search by invoice number/supplier, status, and invoice-date range.
- `PENDING_SYNC` invoices can be corrected locally and synchronized again.
- Editing a `SYNCED` invoice sends an update to its existing KiotViet purchase order; it does not create a replacement order.
- The automatic KiotViet sync option is disabled by default. Enable it under **Sửa thông tin → KiotViet**, then choose a 15–1,440 minute interval. The Node process must remain running.

## Troubleshooting (upload / Gemini errors)

The red text on **Tải ảnh hóa đơn** is the next action. Also look at the **backend terminal** for `Gemini invoice extraction failed:` (the API key is never printed).

| Message on screen | What to do |
| --- | --- |
| `Gemini chưa được cấu hình…` | Put a non-empty `GEMINI_API_KEY` in `backend/.env`, then **restart** the server. |
| `GEMINI_API_KEY sai hoặc không có quyền…` | Create a new key in [Google AI Studio](https://aistudio.google.com/app/apikey), paste it into `backend/.env` with no quotes/spaces, restart. Enable the Generative Language API if asked. |
| `Model Gemini không tồn tại…` | Check the configured endpoint and the key's model group. Keep `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` set to models the key can use, then restart. |
| `API không đủ credit…` | Kiểm tra quota và billing của Google AI Studio/Google Cloud cho key đang dùng. |
| `Gemini bị giới hạn quota/rate limit…` | Wait and retry. Check quota/billing in Google AI Studio. |
| `Gemini hết thời gian chờ…` / terminal `This operation was aborted` | The HTTP client cancelled the call (default used to be 30s). Set `GEMINI_TIMEOUT_MS=120000` in `backend/.env`, **restart**, retry. Keep the upload tab open until Gemini finishes. |
| `Gemini trả về JSON không hợp lệ` / `không đúng schema` | Extraction failed validation. Retry; do not invent data. Edit the prompt only in `backend/services/geminiInvoicePrompt.js`. |
| `Không tìm thấy file test_images/01…` | Keep a file named `01` plus real extension, e.g. `backend/test_images/01.jfif`. |
| `Gemini không đọc được hóa đơn này.` + extra text | The extra text is the sanitized API/SDK reason. Use it with the terminal log. Typical leftover causes: no internet, DNS, firewall, or a model/schema error that is not 404. |
| Preview works but extract fails after you just saved the key | You did not restart Node. Ctrl+C then `npm.cmd start` in `backend`. |

Do not commit `backend/.env`. If the message is still unclear, copy the **on-screen error** and the **terminal** `Gemini invoice extraction failed` line (not the key) when asking for help.

## Project layout

### Thực nghiệm trích xuất Gemini

Hướng dẫn script chạy tuần tự 26 ảnh, lưu JSON từng ảnh, tiếp tục lượt dở và xuất PDF/CSV đánh giá thủ công: [Thực nghiệm Gemini](docs/GEMINI_EXTRACTION_EXPERIMENT.md). Lệnh `experiment:gemini -- run` mới gọi API thật; plan, users, images và report không gọi Gemini. Script không ghi DB hoặc gửi KiotViet.

- `backend/server.js` — Express API + static frontend
- `backend/services/geminiInvoicePrompt.js` — Gemini prompt (edit here)
- `backend/services/geminiClient.js` — shared server-side Gemini endpoint/client and secret redaction
- `backend/services/geminiInvoiceService.js` — Gemini call + schema validation
- `backend/services/invoiceMappingService.js` — application mapping stub
- `backend/services/testInvoiceImageService.js` — loads `test_images/01`
- `frontend/upload-invoice.html` — test upload + preview
- `frontend/invoice-correction.html` — correction UI

## Cài đặt và hiệu chỉnh hóa đơn

- Nút bánh răng trên navbar mở **Cài đặt**: cỡ chữ Nhỏ / Mặc định / Lớn và đổi mật khẩu. Cỡ chữ áp dụng ngay, lưu bằng `localStorage` trên trình duyệt hiện tại. Không lặp lại cấu hình kết nối trên navbar.
- Đổi mật khẩu cần mật khẩu hiện tại, mật khẩu mới (ít nhất 8 ký tự, tối đa 72 byte UTF-8) và xác nhận trùng khớp. Backend băm bằng bcrypt, giữ phiên hiện tại và đăng xuất các phiên khác của tài khoản. Endpoint: `PUT /api/auth/password`.
- Trang sửa hóa đơn có nút **Xóa** trên từng dòng, kèm modal xác nhận. Sau khi xóa, STT và tổng tiền cập nhật; dòng bị xóa không nằm trong payload xác nhận, không tạo mapping hoặc gửi KiotViet. JSON OCR gốc vẫn được giữ để đối chiếu.
- Mọi thay đổi trên trang sửa hóa đơn được tự lưu vào `localStorage` theo phiên sau khoảng 700 ms và khi rời tab. Mở lại đúng phiên trên cùng trình duyệt sẽ khôi phục nhà cung cấp, hàng đã chọn, các giá trị đã sửa và cả các dòng đã xóa; bản nháp bị xóa sau khi xác nhận thành công.
- Thuế có thể nhập theo `%` hoặc `VND`; SAPI lưu riêng và phân bổ vào đơn giá dòng khi gửi KiotViet. Tiền trả nhà cung cấp được gửi qua `paidAmount`; số hóa đơn được dùng làm mã phiếu KiotViet khi có. Giới hạn và cách trình bày trong báo cáo được ghi tại `docs/KIOTVIET_TAX_LIMITATION.md`.
- Danh sách hóa đơn hỗ trợ chọn và xóa hàng loạt các phiên/hóa đơn chưa đồng bộ; hóa đơn đã đồng bộ không bị xóa cục bộ để tránh mất liên kết với KiotViet.
- Không thể xác nhận hóa đơn rỗng, số lượng/đơn giá chưa điền hoặc chiết khấu lớn hơn tổng tiền hàng.
- Thông báo thành công ngắn dùng toast; lỗi cần xử lý được giữ trong trang; thao tác hủy/xóa dùng modal. Các helper trong `frontend/app.js` không phụ thuộc JavaScript của Tabler/Bootstrap.
- Prompt phân biệt danh mục mẫu không dùng, hàng viết bổ sung và hàng bị gạch/sửa. Không thêm matching, không thay schema JSON hoặc schema database. Cần kiểm tra kết quả thực tế trên các mẫu đặc biệt; prompt không bảo đảm AI đọc đúng mọi ảnh.

### Kiểm thử các thay đổi

Chạy trong thư mục `backend`:

```powershell
node scripts/test-password-and-validation.js
```

Bài test này dùng database double trong bộ nhớ, không thay mật khẩu hay dữ liệu thật. Bài kiểm thử trình duyệt `scripts/test-correction-settings.js` cần một bản cài Playwright và Microsoft Edge, cùng kết nối để tải CSS Tabler; có thể đặt `NODE_PATH` tới thư mục chứa package Playwright có sẵn rồi chạy `node scripts/test-correction-settings.js`. Nó dùng fixture API tách biệt, không gọi Gemini hay KiotViet. Có thể đặt `SAPI_TEST_BROWSER=chrome` nếu dùng Chrome thay Edge.

Để thử OCR thật: restart backend sau khi sửa prompt, mở phiên mới, upload ảnh, bấm **Gửi ảnh**, kiểm tra kết quả và thử xóa dòng trước khi xác nhận. Không bấm xác nhận trên gian hàng thật chỉ để kiểm thử, vì thao tác này có thể tạo phiếu nhập KiotViet. Checklist mẫu thử nằm trong `docs/CHUAN_BI_SUA.md`.

## Chế độ KiotViet

`KIOTVIET_MODE=live` (default) uses both the real OAuth endpoint and the real Public API. `KIOTVIET_MODE=mock` uses both token and data endpoints from the local mock; the two modes are never mixed.

For a local mock test, start the backend with `KIOTVIET_MODE=mock`, then connect using any non-empty Client ID/secret and retailer `sapi-mock`. The mock implements only the endpoints SAPI uses: token, branches, categories, suppliers, products, and purchase orders.

Run `npm.cmd run test:kiotviet:mock` while that mock-mode backend is running. The test verifies both outcomes: a successful purchase order changes the invoice from `PENDING_SYNC` to `SYNCED`, while a rejected POST leaves it `PENDING_SYNC`. Mock results are not evidence of a successful integration request to the real KiotViet system.
