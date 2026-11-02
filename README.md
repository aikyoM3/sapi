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

   Edit `backend/.env` and set `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/app/apikey). Do not put the key in source files.

   | Variable | Required for Gemini test? | Notes |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | Yes | Empty key → upload previews the image but extraction fails with a clear error |
   | `GEMINI_MODEL` | No | Default `gemini-2.5-flash` |
   | `GEMINI_TIMEOUT_MS` | No | Default `120000` (2 minutes). Vision extraction often exceeds 30s. |
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

**PowerShell:** if `npm start` fails with “running scripts is disabled”, use `npm.cmd start` (and `npm.cmd install`) instead of `npm`. Run those commands inside `backend`, not the project root.

**After any change to `backend/.env` you must restart the server.** `dotenv` only reads the file at process start. Ctrl+C, then `npm.cmd start` again. Filling the key while Node is already running has no effect.

## Multi-page invoice flow

1. **Nhập hàng** → **Bắt đầu nhập phiên hóa đơn**.
2. Select one or more images on the PC and click **Upload**, or scan the QR and send multiple pages from a phone.
3. Add all pages to the same session, then click **Gửi ảnh**. Only this action starts Gemini.
4. The backend sends all pages in order as one invoice and stores the standardized JSON as intermediate `ocr_result`:

```json
{
  "supplier": { "name": null, "phone": null, "address": null, "tax_code": null },
  "invoice": { "number": null, "date": null },
  "items": [{ "name": null, "quantity": null, "unit": null, "unit_price": null, "total_price": null }],
  "total_amount": null
}
```

5. The application scopes supplier/product mapping to the logged-in account. Product autocomplete searches product names, codes, and external names with a debounce.
6. **Sửa hóa đơn** calculates each line, subtotal, discount, and payment total in the browser; the backend validates and recalculates them again.
7. Only **Xác nhận hóa đơn** creates `purchaseinvoice` and `purchaseinvoiceitem`, updates mapping where applicable, marks the session confirmed, and deletes temporary image files.

## Troubleshooting (upload / Gemini errors)

The red text on **Tải ảnh hóa đơn** is the next action. Also look at the **backend terminal** for `Gemini invoice extraction failed:` (the API key is never printed).

| Message on screen | What to do |
| --- | --- |
| `Gemini chưa được cấu hình…` | Put a non-empty `GEMINI_API_KEY` in `backend/.env`, then **restart** the server. |
| `GEMINI_API_KEY sai hoặc không có quyền…` | Create a new key in [Google AI Studio](https://aistudio.google.com/app/apikey), paste it into `backend/.env` with no quotes/spaces, restart. Enable the Generative Language API if asked. |
| `Model Gemini không tồn tại…` | In `backend/.env` set `GEMINI_MODEL=gemini-2.0-flash` (or another model your key can use), restart. Default `gemini-2.5-flash` is not available on every key. |
| `Gemini bị giới hạn quota/rate limit…` | Wait and retry. Check quota/billing in Google AI Studio. |
| `Gemini hết thời gian chờ…` / terminal `This operation was aborted` | The HTTP client cancelled the call (default used to be 30s). Set `GEMINI_TIMEOUT_MS=120000` in `backend/.env`, **restart**, retry. Keep the upload tab open until Gemini finishes. |
| `Gemini trả về JSON không hợp lệ` / `không đúng schema` | Extraction failed validation. Retry; do not invent data. Edit the prompt only in `backend/services/geminiInvoicePrompt.js`. |
| `Không tìm thấy file test_images/01…` | Keep a file named `01` plus real extension, e.g. `backend/test_images/01.jfif`. |
| `Gemini không đọc được hóa đơn này.` + extra text | The extra text is the sanitized API/SDK reason. Use it with the terminal log. Typical leftover causes: no internet, DNS, firewall, or a model/schema error that is not 404. |
| Preview works but extract fails after you just saved the key | You did not restart Node. Ctrl+C then `npm.cmd start` in `backend`. |

Do not commit `backend/.env`. If the message is still unclear, copy the **on-screen error** and the **terminal** `Gemini invoice extraction failed` line (not the key) when asking for help.

## Project layout

- `backend/server.js` — Express API + static frontend
- `backend/services/geminiInvoicePrompt.js` — Gemini prompt (edit here)
- `backend/services/geminiInvoiceService.js` — Gemini call + schema validation
- `backend/services/invoiceMappingService.js` — application mapping stub
- `backend/services/testInvoiceImageService.js` — loads `test_images/01`
- `frontend/upload-invoice.html` — test upload + preview
- `frontend/invoice-correction.html` — correction UI

## KiotViet

`KIOTVIET_MODE=live` (default) uses both the real OAuth endpoint and the real Public API. `KIOTVIET_MODE=mock` uses both token and data endpoints from the local mock; the two modes are never mixed.

For a local mock test, start the backend with `KIOTVIET_MODE=mock`, then connect using any non-empty Client ID/secret and retailer `sapi-mock`. The mock implements only the endpoints SAPI uses: token, branches, categories, suppliers, products, and purchase orders.

Run `npm.cmd run test:kiotviet:mock` while that mock-mode backend is running. The test verifies both outcomes: a successful purchase order changes the invoice from `PENDING_SYNC` to `SYNCED`, while a rejected POST leaves it `PENDING_SYNC`. Mock results are not evidence of a successful integration request to the real KiotViet system.
