# Sửa lỗi upload ảnh hóa đơn

Ngày kiểm tra và sửa: 2026-09-08

## Hiện tượng

Backend đang online và trang đăng nhập trả HTTP 200, nhưng request upload ảnh thất bại:

```text
POST /api/invoice-sessions/:token/images
HTTP 500
Response: Đã có lỗi máy chủ. Vui lòng thử lại.
Session status: WAITING_IMAGES
Image count: 0
```

Terminal backend ghi nhận:

```text
EPERM: operation not permitted, open
D:\School-related\project-I\backend\temporary_invoice_images\<generated-name>.jpg
```

Lỗi phát sinh trong `saveTemporaryImage()` tại `backend/services/imageFileService.js`, ở bước `fs.writeFile()`.

## Cách xác minh nguyên nhân

Ảnh kiểm thử `backend/test_images/01.jfif` là JPEG hợp lệ, dung lượng 190.473 byte. Thử ghi một file tối thiểu trực tiếp vào `backend/temporary_invoice_images` cũng trả cùng lỗi `EPERM`.

Điều này xác nhận request multipart, kiểm tra định dạng ảnh và dữ liệu ảnh không phải nguyên nhân trực tiếp. Tiến trình Node không thể tạo file mới trong thư mục lưu tạm cũ tại thời điểm kiểm thử.

## Thay đổi đã thực hiện

File sửa: `backend/services/imageFileService.js`.

- Thư mục ảnh tạm mặc định được chuyển sang thư mục temp có quyền ghi của hệ điều hành:

```text
C:\Users\Admin\AppData\Local\Temp\sapi-temporary-invoice-images
```

- Có thể cấu hình vị trí khác bằng biến môi trường:

```env
SAPI_TEMP_IMAGE_DIR=
```

- Nếu biến trên để trống, backend dùng `os.tmpdir()/sapi-temporary-invoice-images`.
- Cơ chế tên file ngẫu nhiên, kiểm tra MIME, lưu đường dẫn vào database và xóa file khi hủy/hoàn thành session được giữ nguyên.
- `backend/.env.example` đã được bổ sung mô tả biến môi trường mới.

## Kiểm tra trực tiếp service

Đã chạy syntax check và gọi trực tiếp `saveTemporaryImage()` bằng ảnh JPEG kiểm thử.

Kết quả:

```text
directory: C:\Users\Admin\AppData\Local\Temp\sapi-temporary-invoice-images
fileSize: 190473
mimeType: image/jpeg
exists: true
removed: true
```

Trạng thái: PASS.

## Kiểm tra qua API upload

Điều kiện:

- Backend được restart sau khi sửa.
- Tạo tài khoản và invoice session tạm.
- Upload `test_images/01.jfif` bằng multipart field `invoiceImages`.

Kết quả lần kiểm tra trạng thái:

```json
{
  "uploadHttp": 201,
  "uploadResponse": { "added": 1 },
  "sessionStatus": "READY_TO_PROCESS",
  "imageCount": 1
}
```

Trạng thái: PASS. Hóa đơn chuyển từ `WAITING_IMAGES` sang `READY_TO_PROCESS` sau khi lưu ảnh thành công.

## Kiểm tra đọc và dọn dẹp ảnh

Sau khi upload, test gọi endpoint chi tiết session để lấy URL ảnh, đọc lại ảnh và hủy session.

Kết quả:

```json
{
  "uploadHttp": 201,
  "imageHttp": 200,
  "contentType": "image/jpeg",
  "existedBeforeCancel": true,
  "cancelHttp": 204,
  "existsAfterCancel": false
}
```

Trạng thái: PASS.

- File tồn tại sau khi upload.
- Endpoint trả ảnh HTTP 200 với `Content-Type: image/jpeg`.
- Hủy session trả HTTP 204.
- File vật lý không còn sau khi hủy session.

## Dữ liệu kiểm thử

Các tài khoản, invoice session và file ảnh được tạo tạm trong quá trình kiểm tra đã được xóa sau test. Không sử dụng hoặc ghi log credential KiotViet/Gemini.

## Phạm vi chưa kiểm tra

Lần kiểm tra này dừng sau bước lưu và đọc ảnh. Không gọi Gemini OCR, vì mục tiêu là xác nhận riêng chức năng upload và tránh tiêu thụ API quota.

## Trạng thái cuối cùng

```text
Upload ảnh: PASS
Đọc lại ảnh: PASS
Chuyển trạng thái session: PASS
Xóa ảnh khi hủy session: PASS
Gemini OCR: NOT RUN trong lần kiểm tra này
```
