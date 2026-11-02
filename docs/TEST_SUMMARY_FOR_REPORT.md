# Tổng hợp kiểm thử dùng cho báo cáo KLTN

Cập nhật: 2026-09-07. Đây là nguyên liệu báo cáo dựa trên các test đã xác minh, chưa phải văn phong luận văn hoàn chỉnh.

## Authentication

- Chức năng: đăng ký username/password, đăng nhập và session.
- Điều kiện: PostgreSQL và backend local hoạt động.
- Kết quả: PASS qua targeted API test.
- Trạng thái sau sửa: session được dùng để giới hạn dữ liệu theo account.

## Invoice Session và Invoice Review

- Chức năng: phân biệt phiên chờ ảnh/phiên sẵn sàng review, xác nhận, hủy và đồng bộ lại.
- Kết quả: PASS cho lifecycle và quy tắc hủy bằng test API/DB.
- Lỗi quan trọng từng phát hiện: phiên chưa upload bị đưa vào danh sách hóa đơn; thao tác theo trạng thái chưa rõ.
- Trạng thái sau sửa: chỉ `READY_FOR_REVIEW` xuất hiện là chưa hoàn thành; `PENDING_SYNC` được phép retry/hủy; `SYNCED` không được hủy.
- Upload ảnh end-to-end: chưa đủ bằng chứng xác nhận PASS; từng có log `EPERM` khi ghi ảnh cần kiểm tra riêng.

## Gemini OCR

- Chức năng kiểm thử: tạo buyer context và loại supplier trùng MST/số điện thoại người mua.
- Kết quả: PASS ở mức unit/targeted.
- Lỗi quan trọng: mô hình có thể nhận nhầm bên mua thành nhà cung cấp.
- Trạng thái sau sửa: context người mua được gửi trong prompt và supplier bị xóa trước mapping nếu trùng strong identifier.
- Gemini API thật/OCR ảnh thật: chưa đủ bằng chứng xác nhận đã PASS.

## Database

- Chức năng: profile cửa hàng nullable và ownership dữ liệu.
- Kết quả: PASS qua PUT/GET profile, clear về `NULL`, và kiểm tra thao tác chéo account.
- Trạng thái sau sửa: thông tin cửa hàng thuộc đúng account, không bắt buộc khi đăng ký.

## Kiểm thử với KiotViet thật

- Phạm vi đã xác minh: OAuth client credentials thật trả token thành công.
- Bước verify retailer `GET /branches`: FAILED với HTTP 402.
- Kết luận phù hợp: đã chứng minh SAPI gọi được OAuth KiotViet thật; chưa chứng minh được data sync thật hoặc tạo phiếu nhập thật.
- Không được trình bày `POST /purchaseorders` live là PASS vì không có bằng chứng request thành công.
- Không lưu Client Secret, access token hoặc credential trong tài liệu.

## Kiểm thử với KiotViet Mock API

- Điều kiện: backend chạy `KIOTVIET_MODE=mock`; token và data endpoints đều trỏ tới cùng local mock API.
- Chức năng: mock authentication, branches, categories, suppliers, products và purchase orders.
- Kết quả data sync: PASS.
- Kết quả purchase order thành công: invoice chuyển `PENDING_SYNC` → `SYNCED` chỉ sau khi mock POST thành công; external ID/code được lưu.
- Kết quả purchase order lỗi: PASS; mock trả 503 và invoice vẫn `PENDING_SYNC`, external ID không được lưu.
- Ý nghĩa: xác nhận mapping và state transition của SAPI trong môi trường kiểm thử; không đại diện cho kết quả với hệ thống KiotViet thật.

## QR / LAN Mobile Upload

- Có code tạo QR và xác định LAN URL.
- Chưa đủ bằng chứng cho kiểm thử end-to-end từ điện thoại; không ghi PASS trong báo cáo nếu chưa retest thực tế.

## Navbar / UI

- Chức năng: shared navbar, modal Sửa thông tin, section cửa hàng/KiotViet/Gemini, loại internal ID.
- Kết quả: PASS ở mức syntax và static source assertions.
- Giới hạn: chưa có bằng chứng visual/browser test hoàn chỉnh cho mọi interaction.

## Security / Ownership

- Chức năng: chống truy cập/sửa/xóa dữ liệu thuộc account khác.
- Kết quả: PASS qua targeted API test cho session, invoice, product, supplier và mapping.
- Credential UI/source: không prefill secret/key; chưa thực hiện penetration test toàn diện.
