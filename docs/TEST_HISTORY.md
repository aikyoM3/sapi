# Lịch sử kiểm thử SAPI

Cập nhật: 2026-09-07. Tài liệu này chỉ ghi nhận kết quả có bằng chứng trong task Codex hiện tại hoặc trong test artifact của dự án.

## Phạm vi bằng chứng

- Có test script: `backend/scripts/test-lifecycle-edit.js`, `backend/scripts/test-kiotviet-connection.js`, `backend/scripts/test-kiotviet-mock-purchase-order.js`.
- Workspace hiện tại không phải Git repository, nên không có commit/diff Git để đối chiếu.
- Không tìm thấy `CODEX_PROGRESS.md` hay log test được lưu lâu dài.
- Output terminal của các lần chạy ngày 2026-09-07 được ghi lại dưới đây. Không suy ra PASS chỉ từ việc test code tồn tại.

## Authentication

### Đăng ký, đăng nhập và session

- Thời điểm: 2026-09-07.
- Mục tiêu: tạo tài khoản bằng username/password, đăng nhập và dùng session cookie gọi API có bảo vệ.
- Cách test: test tạo hai tài khoản tạm, đăng nhập tài khoản A và gọi các endpoint bằng cookie nhận được.
- Command đã chạy: `node scripts/test-lifecycle-edit.js`.
- Kết quả: PASS.
- Lỗi phát hiện/xử lý: không phát hiện lỗi mới trong lần chạy cuối.
- Trạng thái cuối: hoạt động.
- Evidence: `backend/scripts/test-lifecycle-edit.js`; output `TARGETED_TEST_SUCCESS: store profile nullable, buyer OCR guard, shared modal/navbar, integration validation, existing lifecycle/ownership`.

## Invoice Session / Upload

### Vòng đời danh sách và hủy phiên

- Thời điểm: 2026-09-07.
- Mục tiêu: không đưa `WAITING_IMAGES` vào danh sách hóa đơn; đưa `READY_FOR_REVIEW` vào dưới trạng thái `INCOMPLETE`; chỉ chủ sở hữu được hủy phiên.
- Cách test: seed session ở hai trạng thái cho hai tài khoản, gọi API danh sách và DELETE.
- Command đã chạy: `node scripts/test-lifecycle-edit.js`.
- Kết quả: PASS.
- Lỗi phát hiện trước đó: session chưa upload từng bị hiển thị như hóa đơn chưa hoàn thành.
- Cách xử lý: chỉ lấy `READY_FOR_REVIEW`; thêm kiểm tra ownership khi hủy.
- Trạng thái cuối: hoạt động theo targeted test.
- Evidence: `backend/scripts/test-lifecycle-edit.js`, `backend/routes/dataRoutes.js`, `backend/routes/invoiceSessionRoutes.js`.

### Upload ảnh thật từ desktop/mobile

- Không đủ bằng chứng để xác nhận đã chạy thành công trong lịch sử hiện còn truy cập được.
- Có log terminal cũ về lỗi ghi file `EPERM` trong `temporary_invoice_images`, nhưng không có output xác nhận đã xử lý hoặc retest PASS; không đánh dấu PASS.

## Gemini OCR

### Buyer context và hậu kiểm supplier

- Thời điểm: 2026-09-07.
- Mục tiêu: chỉ đưa field cửa hàng có dữ liệu vào prompt; xóa supplier nếu MST hoặc số điện thoại trùng buyer.
- Cách test: gọi trực tiếp `buildBuyerContext()` và `removeBuyerFromSupplier()` bằng fixture trong targeted test.
- Command đã chạy: `node scripts/test-lifecycle-edit.js`.
- Kết quả: PASS ở mức unit/targeted.
- Lỗi phát hiện trước đó: Gemini có thể lấy người mua làm nhà cung cấp.
- Cách xử lý: buyer context trong prompt và strong-identifier guard trước mapping.
- Trạng thái cuối: logic bảo vệ đã được xác nhận; chưa phải test OCR live.
- Evidence: `backend/services/geminiInvoiceService.js`, `backend/routes/invoiceSessionRoutes.js`, `backend/scripts/test-lifecycle-edit.js`.

### OCR bằng Gemini API thật

- Không đủ bằng chứng để xác nhận đã chạy thành công. Không có output/API artifact chứng minh một hóa đơn đã được Gemini thật xử lý thành công trong lịch sử hiện có.

## Invoice Review

### Hủy và đồng bộ lại hóa đơn theo trạng thái

- Thời điểm: 2026-09-07.
- Mục tiêu: chỉ hủy `PENDING_SYNC`, không hủy `SYNCED`, không thao tác hóa đơn của tài khoản khác.
- Command đã chạy: `node scripts/test-lifecycle-edit.js`.
- Kết quả: PASS.
- Evidence: `backend/scripts/test-lifecycle-edit.js`, `backend/routes/dataRoutes.js`.

## Database

### Profile cửa hàng nullable

- Thời điểm: 2026-09-07.
- Mục tiêu: lưu và đọc tên cửa hàng, MST, địa chỉ, điện thoại, email; cho phép xóa thành `NULL`.
- Cách test: PUT/GET `/api/auth/profile`, sau đó PUT body rỗng và kiểm tra toàn bộ field là `null`.
- Command đã chạy: `node scripts/test-lifecycle-edit.js`.
- Kết quả: PASS.
- Migration: `008_account_store_profile.sql` đã được backend báo `Applied migration 008_account_store_profile.sql` trong terminal ngày 2026-09-07.
- Evidence: migration, `backend/routes/authRoutes.js`, targeted test.

## KiotViet Connection

### Kiểm tra KiotViet thật bằng development credentials

- Thời điểm: trong task Codex hiện tại, trước lần cập nhật 2026-09-07; không còn timestamp chính xác.
- Mục tiêu: OAuth client credentials và verify retailer bằng `GET /branches`.
- Request đã chạy: `POST https://id.kiotviet.vn/connect/token`, sau đó `GET https://public.kiotapi.com/branches`.
- Command shell chính xác: không còn đủ bằng chứng để xác nhận; script tương ứng là `backend/scripts/test-kiotviet-connection.js`.
- Kết quả: OAuth SUCCESS, access token tồn tại; verify retailer FAILED với HTTP 402.
- Lỗi phát hiện: gian hàng/API không hoạt động ở bước Public API. HTTP 402 là bằng chứng response; không đủ căn cứ khẳng định duy nhất rằng tài khoản đã hết hạn.
- Trạng thái cuối: OAuth thật đã được xác nhận; retailer API chưa READY.
- Evidence: lịch sử task Codex hiện tại và `backend/scripts/test-kiotviet-connection.js`. Không có secret/token được lưu trong tài liệu.

### Kết nối KiotViet Mock

- Thời điểm: 2026-09-07.
- Mục tiêu: xác nhận mock OAuth, verify branch và data sync dùng hoàn toàn local mock endpoints.
- Điều kiện: backend chạy với `KIOTVIET_MODE=mock`.
- Command đã chạy: `node scripts/test-kiotviet-mock-purchase-order.js`.
- Kết quả: PASS.
- Evidence: `backend/mock/kiotVietMockRoutes.js`, fixtures và output `MOCK_PURCHASE_ORDER_TEST_SUCCESS...`.

## KiotViet Data Sync

### Đồng bộ branch/category/supplier/product với Mock API

- Thời điểm: 2026-09-07.
- Mục tiêu: gọi bốn endpoint mock có cùng response shape cần thiết và upsert dữ liệu.
- Command đã chạy: `node scripts/test-kiotviet-mock-purchase-order.js`.
- Kết quả: PASS; endpoint `/api/integrations/kiotviet/sync` trả HTTP 200 trong assertion.
- Evidence: mock test script, `backend/kiotviet.js`, fixture JSON.

### Đồng bộ dữ liệu với KiotViet thật

- Không đủ bằng chứng để xác nhận đã chạy thành công; verify retailer thật trước đó dừng ở HTTP 402.

## KiotViet Purchase Order Sync

### PurchaseInvoice qua Mock API — thành công

- Thời điểm: 2026-09-07.
- Mục tiêu: `PENDING_SYNC` → mapping payload → `POST /purchaseorders` → lưu external ID/code → `SYNCED`.
- Điều kiện: `KIOTVIET_MODE=mock`, có branch, product code và connection mock.
- Command đã chạy: `node scripts/test-kiotviet-mock-purchase-order.js`.
- Kết quả: PASS. Mock nhận order; local invoice có `kiotviet_purchase_order_id`, `kiotviet_purchase_order_code`, trạng thái `SYNCED`.
- Evidence: output `MOCK_PURCHASE_ORDER_TEST_SUCCESS: PENDING_SYNC -> SYNCED after POST; failed POST remains PENDING_SYNC`; test script; `backend/services/purchaseInvoiceSyncService.js`.

### PurchaseInvoice qua Mock API — lỗi

- Thời điểm: 2026-09-07.
- Mục tiêu: khi mock `POST /purchaseorders` trả lỗi, hóa đơn không được đánh dấu hoàn thành.
- Cách test: product code fixture `MOCK-FAIL` khiến mock trả HTTP 503.
- Command đã chạy: `node scripts/test-kiotviet-mock-purchase-order.js`.
- Kết quả: PASS; API SAPI trả lỗi và invoice giữ `PENDING_SYNC`, external ID vẫn `NULL`.
- Evidence: cùng output và test script nêu trên.

### POST phiếu nhập lên KiotViet thật

- Không đủ bằng chứng để xác nhận đã chạy.
- Code hiện có request thật `POST https://public.kiotapi.com/purchaseorders`, nhưng sự tồn tại của code không được coi là bằng chứng test live.

## QR / LAN Mobile Upload

- Có implementation tạo QR và phát hiện địa chỉ LAN, nhưng không đủ bằng chứng còn lại để xác nhận end-to-end upload bằng điện thoại đã PASS.
- Lần start server ngày 2026-09-07 đã in mobile URL, nhưng đó chỉ xác nhận phát hiện địa chỉ, không xác nhận thiết bị khác truy cập/upload được.

## Navbar / UI

### Shared navbar và modal Sửa thông tin

- Thời điểm: 2026-09-07.
- Mục tiêu: các section và navbar được tạo từ nguồn chung; không hiển thị internal ID/modal KiotViet cũ.
- Cách test: static assertions trên `frontend/app.js` và `frontend/index.html` trong targeted test; syntax check `node --check frontend/app.js`.
- Kết quả: PASS ở mức source/static validation.
- Giới hạn: không đủ bằng chứng cho visual/browser test toàn bộ tương tác view/edit.
- Evidence: `backend/scripts/test-lifecycle-edit.js`, `frontend/app.js`.

## Security / Ownership

### Cô lập dữ liệu theo account

- Thời điểm: 2026-09-07.
- Mục tiêu: tài khoản A không sửa sản phẩm, supplier, mapping hoặc xóa session/invoice của tài khoản B.
- Command đã chạy: `node scripts/test-lifecycle-edit.js`.
- Kết quả: PASS; các thao tác chéo account trả 404 hoặc bị chặn theo assertion.
- Evidence: targeted test và các route tương ứng.

### Không lộ credential

- Kiểm tra source cho thấy client secret, Gemini key và access token không được prefill vào UI; script KiotViet thật chỉ log token tồn tại/độ dài.
- Đây là source review, không phải penetration test. Không đủ bằng chứng để tuyên bố đã thực hiện security test toàn diện.
