# KiotViet: trạng thái hoàn tất phiếu nhập

## Vấn đề đang chờ kiểm chứng

SAPI hiện gửi `POST /purchaseorders` với:

```json
{
  "isDraft": 1
}
```

Trường này được tạo trong `backend/kiotviet.js`, hàm `buildPurchaseOrderPayload()`.

Tài liệu Public API KiotViet mô tả `isDraft` là trạng thái của phiếu nhập, nhưng phần tài liệu đang tham chiếu **không xác nhận rõ** giá trị số nào là nháp hoặc hoàn tất. Không được tự đổi sang `0` hay giá trị khác chỉ dựa trên tên trường.

## Mục tiêu nghiệp vụ mong muốn

Người dùng chỉ cần kiểm tra hóa đơn trên SAPI và bấm một lần:

```text
Xác nhận nhập hàng trên SAPI
  → SAPI tạo trực tiếp phiếu nhập hoàn tất trên KiotViet
  → Không yêu cầu người dùng vào KiotViet bấm lưu nháp rồi hoàn tất cho từng hóa đơn
```

## Câu hỏi cần xác nhận bằng gian hàng test

1. `isDraft: 1` hiển thị là trạng thái gì trong giao diện KiotViet?
2. Giá trị nào tạo phiếu nhập hoàn tất?
3. Tạo phiếu hoàn tất có tăng tồn kho ngay không?
4. Phiếu hoàn tất còn gọi `PUT /purchaseorders/{id}` để sửa được không?
5. Nếu không sửa được, quy trình KiotViet yêu cầu hủy, trả hàng hay tạo phiếu điều chỉnh?
6. Có thể xóa/hủy phiếu test bằng API để làm sạch dữ liệu thử nghiệm không?

## Kế hoạch kiểm tra an toàn

Chỉ thực hiện trên gian hàng test hoặc dữ liệu được phép thử:

1. Tạo một phiếu test với `isDraft: 1`.
2. Gọi `GET /purchaseorders/{id}` và kiểm tra trạng thái trong API lẫn giao diện KiotViet.
3. Tạo hoặc cập nhật một phiếu test với giá trị được KiotViet xác nhận là hoàn tất.
4. Kiểm tra tồn kho, khả năng cập nhật và khả năng hủy/xóa.
5. Chỉ sau khi có kết quả mới thay đổi payload trong SAPI.

## Quyết định triển khai sau kiểm tra

- Nếu phiếu hoàn tất vẫn cho cập nhật: SAPI gửi trực tiếp trạng thái hoàn tất và giữ chức năng sửa hóa đơn đã đồng bộ.
- Nếu phiếu hoàn tất không cho cập nhật: SAPI gửi trực tiếp trạng thái hoàn tất, nhưng khóa sửa sau xác nhận; sai sót sẽ theo quy trình hủy/điều chỉnh của KiotViet.

## Tham chiếu

- KiotViet Public API: tạo phiếu nhập `POST /purchaseorders`.
- KiotViet Public API: cập nhật phiếu nhập `PUT /purchaseorders/{id}`.
- Tài liệu hiện hành: <https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-ket-noi-api/public-api/>.
