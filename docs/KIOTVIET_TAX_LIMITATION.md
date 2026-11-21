# Ghi chú báo cáo: xử lý thuế khi nhập hàng KiotViet

Một số hóa đơn nhà cung cấp ghi thuế thành một mục riêng phía dưới phần hàng hóa. Trong luồng tích hợp hiện tại, payload tạo phiếu nhập KiotViet mà SAPI sử dụng không có một ô thuế tổng độc lập phù hợp với cách nhập này.

Giải pháp của SAPI:

- Người dùng nhập thuế theo phần trăm hoặc số tiền VND trên màn hình kiểm tra hóa đơn.
- Nếu nhập phần trăm, SAPI tính số tiền thuế trên giá trị hàng sau chiết khấu.
- Nếu nhập VND, SAPI suy ra tỷ lệ phần trăm tương ứng để người dùng kiểm tra.
- SAPI lưu riêng chế độ nhập, tỷ lệ và số tiền thuế.
- Khi gửi KiotViet, SAPI phân bổ tổng tiền thuế theo tỷ trọng giá trị các dòng hàng và cộng vào đơn giá từng dòng. Vì vậy phiếu nhập KiotViet nhận đơn giá sau thuế, trong khi tổng tiền cuối cùng vẫn khớp với hóa đơn.

Đây là giải pháp tương thích nghiệp vụ, không phải ánh xạ một trường thuế tổng của SAPI sang một trường thuế tổng tương đương trên KiotViet. Báo cáo cần nêu rõ giới hạn này và sai số làm tròn có thể phát sinh ở mức rất nhỏ khi phân bổ thuế cho nhiều dòng.
