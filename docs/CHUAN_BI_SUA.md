# SAPI chuẩn bị sửa

Cập nhật ngày 17/11/2026. Prompt và các chức năng giao diện bên dưới đã được triển khai. Kiểm thử tương tác dùng dữ liệu tách biệt; chất lượng OCR trên các mẫu thật còn cần kiểm chứng bằng Gemini. Không thay schema database.

## 1 Prompt đọc hóa đơn

### Phiếu mẫu có danh mục in sẵn

- Bỏ qua dòng chỉ có tên, mã, đơn vị hoặc đơn giá in sẵn nhưng không được sử dụng trong giao dịch.
- Với phiếu điền khung đã thảo luận, ô số lượng trống và không có ghi nhận giao hàng nào khác nghĩa là dòng không được dùng. Không tạo item chỉ để điền `quantity: null` cho dòng mẫu đó.
- Không suy ra số lượng từ thành tiền, đơn giá, tổng tiền hoặc dòng bên cạnh.
- Không bắt mọi hóa đơn phải có chữ viết tay: hóa đơn giao dịch in hoàn chỉnh vẫn hợp lệ.

### Hàng viết bổ sung ngoài bảng

Mẫu đối chiếu: `backend/test_images/Đặc biệt/08.jpg`. Theo mô tả người dùng, toàn bộ danh mục in sẵn không dùng; hàng thực tế là năm loại bánh kẹo viết bổ sung ở cuối phiếu. Tên và số lượng cụ thể vẫn phải đọc từ ảnh, không dùng mô tả này làm đáp án cho Gemini.

- Tìm hàng thực tế ở cả vùng trống, cuối bảng, chỗ viết đè hoặc lệch cột.
- Liên kết tên và số lượng theo cụm ghi chép có nghĩa, không bắt trùng một dòng kẻ bảng.
- Chỉ hiểu số trong ngoặc là số lượng khi ngữ cảnh rõ; không mặc định mọi số trong ngoặc đều là số lượng.
- Không sao chép số lượng, đơn giá hoặc thành tiền chung cho từng item, cũng không tự chia tổng nhóm.
- Mặt hàng rõ là có giao dịch nhưng thiếu hoặc không đọc chắc một trường thì trường đó là `null`. Không tự tạo item nếu ngay cả việc xác định đó là mặt hàng thực tế cũng không chắc.
- Không lấy nội dung tờ khác lọt vào nền ảnh.

### Hàng bị gạch hủy hoặc sửa ở cuối phiếu

- Mặt hàng bị gạch hủy rõ ràng do thiếu hàng hoặc in nhầm phải bị loại khỏi kết quả cuối.
- Đọc cả phần bổ sung hoặc sửa ở cuối phiếu. Nếu rõ ràng đó là hàng thay thế, lấy hàng thay thế và không giữ cả hai gây trùng.
- Phân biệt hủy cả dòng với chỉ sửa số lượng hoặc đơn giá. Nếu chỉ sửa một trường, dùng giá trị thay thế rõ ràng và giữ các trường còn lại.
- Đường kẻ bảng, gạch chân, tay che hoặc nét bút đi ngang không mặc nhiên là hủy hàng.
- Quan hệ giữa mục cũ và phần sửa không rõ thì không tự ghép, cộng dồn hoặc phân bổ; trường không chắc để `null` để người dùng kiểm tra.

### Nguyên tắc chung cần sửa

Không áp dụng cứng đề xuất trước là mọi item phải có số lượng dương trên đúng dòng bảng. Thứ tự đọc nên là:

1. Phân biệt biểu mẫu in sẵn với thông tin giao dịch.
2. Tìm mục hàng thực tế, gồm cả danh sách viết bổ sung.
3. Áp dụng dấu hủy và sửa đổi có liên hệ rõ ràng.
4. Trích xuất những mục còn hiệu lực vào schema hiện tại, để `null` cho trường thiếu hoặc không chắc.

Không đoán số, tính ngược số lượng hoặc tự chọn sản phẩm KiotViet. Chưa thêm field cảnh báo hay đổi schema. Prompt ở `backend/services/geminiInvoicePrompt.js`; kiểm tra đầu ra ở `backend/services/geminiInvoiceService.js`.

## 2 Xóa dòng trên màn hình sửa hóa đơn

Yêu cầu bổ sung của người dùng cho `frontend/invoice-correction.html`:

- Thêm nút xóa trên từng dòng để loại hàng Gemini đọc dư hoặc đọc nhầm; giữ giao diện Tabler.
- Xóa xong phải đánh lại STT và tính lại tiền hàng, kiểm tra chiết khấu hợp lệ và tổng thanh toán.
- Dòng đã xóa không gửi trong payload xác nhận, không tạo chi tiết hóa đơn, không tạo hoặc cập nhật ProductMapping và không gửi sang KiotViet.
- Chỉ loại dòng khỏi danh sách người dùng chấp nhận, không xóa hàng trong danh mục và không sửa JSON Gemini gốc trong cửa sổ xem kết quả.
- Không cho xác nhận khi đã xóa hết dòng; báo lỗi ngay trong trang.
- Đã chọn modal xác nhận trước khi xóa thay vì hoàn tác hoặc `window.confirm()`.

## 3 Thông báo nhất quán với Tabler

Đề xuất đã thảo luận: thay dần `window.alert()` và `window.confirm()` bằng helper dùng chung; không xóa các khối `.alert` hữu ích đang nằm trong trang.

| Tình huống | Hiển thị dự kiến |
| --- | --- |
| Thành công ngắn như lưu mapping hoặc đồng bộ danh mục | Toast có thể đóng và tự ẩn |
| Lỗi Gemini hoặc thiếu dữ liệu bắt buộc | Thông báo cố định gần thao tác, không tự biến mất |
| Xóa ảnh, hủy hóa đơn hoặc ngắt kết nối | Modal ghi rõ hành động và hậu quả |
| Đang OCR hoặc đồng bộ | Trạng thái và spinner, khóa thao tác tạo yêu cầu trùng |

- Lỗi Gemini trên trang upload phải giữ ảnh và cho phép thử lại theo flow hiện tại.
- Kiểm tra toast thực tế vì bản trước từng không hoạt động; không chỉ thay lời gọi.
- Thông báo cần đọc được bằng công nghệ hỗ trợ; modal dùng được bằng bàn phím và trả focus về nút mở.

## 4 Cài đặt cá nhân

Phạm vi đề xuất chỉ gồm hai nhóm. Không lặp lại hồ sơ cửa hàng, Gemini, KiotViet và đồng bộ vốn đã nằm trên navbar.

### Đổi mật khẩu

- Mật khẩu hiện tại, mật khẩu mới và xác nhận mật khẩu mới.
- Backend kiểm tra mật khẩu hiện tại và lưu mật khẩu mới bằng cơ chế băm hiện có, không lưu dạng rõ.
- Chưa bổ sung đổi tên đăng nhập hoặc quên mật khẩu.
- Đã chọn giữ phiên hiện tại và xóa các phiên khác của cùng tài khoản trong bảng session hiện có.

### Hiển thị

- Cỡ chữ Nhỏ, Mặc định, Lớn; có thể trở về mặc định.
- Lưu trên trình duyệt bằng `localStorage`, chưa cần sửa database.
- Áp dụng nhất quán cho bảng hóa đơn, danh mục và trang hiệu chỉnh; không gây tràn cột hoặc mất nút.
- Chưa thêm sáng tối trong phạm vi tối thiểu.

## 5 Giữ nguyên phạm vi hệ thống

- Giữ HTML, CSS, JavaScript và thiết kế Tabler hiện có.
- Gemini chỉ đọc; không thêm AI matching hay fuzzy matching. Vẫn dùng mapping người dùng đã xác nhận, nếu chưa có thì người dùng chọn hàng hợp lệ trong danh mục KiotViet.
- Không tạo hoặc sửa danh mục trực tiếp trong SAPI, không thay schema trong đợt ghi chú này.
- Vấn đề nháp hoặc hoàn tất phiếu nhập được theo dõi riêng tại `docs/KIOTVIET_PURCHASE_ORDER_FINALIZATION.md`, không tự đổi cùng các mục trên.

## 6 Checklist khi triển khai

- [ ] Phiếu giao dịch in bình thường vẫn đọc đủ mục và trường có thể đọc.
- [ ] Phiếu mẫu không sinh item từ dòng không được sử dụng.
- [ ] Mẫu `08.jpg` lấy danh sách viết bổ sung, không lấy danh mục mẫu hoặc tự chia giá chung.
- [ ] Gạch hủy loại đúng hàng; sửa một trường không làm mất cả hàng; phần thay thế không bị bỏ sót hoặc tính hai lần.
- [ ] Trường không chắc để `null`, không tự đoán hoặc tính ngược.
- [x] Xóa dòng cập nhật STT, tổng tiền và payload; backend chỉ xử lý các dòng trong payload nên hàng đã xóa không được tạo mapping hoặc gửi KiotViet.
- [x] Không xác nhận hóa đơn rỗng; JSON Gemini gốc không bị sửa khi xóa dòng.
- [x] Kiểm thử trình duyệt với CSS Tabler thật: toast, modal, Escape và trả focus; kiểm tra bố cục cài đặt ở kích thước điện thoại.
- [x] Đổi mật khẩu từ chối mật khẩu hiện tại sai, xác nhận không khớp, mật khẩu quá ngắn/dài và trùng mật khẩu cũ. Kiểm tra hash mới và thu hồi phiên khác bằng bài test tách biệt; chưa đổi tài khoản thật.
- [x] Cỡ chữ giữ khi tải lại trang và reset về mặc định; bảng vẫn cuộn ngang và modal không vượt chiều rộng màn hình điện thoại.

Hai bài test tách biệt: `backend/scripts/test-password-and-validation.js` và `backend/scripts/test-correction-settings.js`. Bài trình duyệt dùng fixture, không gửi ảnh Gemini hoặc tạo phiếu nhập thật.

Các tình huống OCR phía trên mới được bổ sung vào prompt, không đánh dấu đạt khi chưa chạy và kiểm tra kết quả từ API thật trên từng ảnh.

## 7 To do báo thiếu dữ liệu và highlight trường cần sửa

Trạng thái: mới ghi yêu cầu, chưa triển khai.

- [ ] Khi người dùng xác nhận mà thiếu thông tin bắt buộc, hiện thông báo cố định trong trang, nêu rõ thiếu gì và ở dòng hàng nào; không chỉ báo chung hoặc dùng toast tự ẩn.
- [ ] Đánh dấu trực tiếp ô lỗi bằng viền và thông báo ngắn bên dưới, tái sử dụng `is-invalid` và `invalid-feedback` của Tabler. Không chỉ dựa vào màu đỏ; bổ sung `aria-invalid` và liên kết mô tả lỗi cho trình đọc màn hình.
- [ ] Tự cuộn và focus tới ô lỗi đầu tiên, kể cả ô nằm ngoài vùng nhìn thấy của bảng cuộn ngang. Có thể đánh dấu nhẹ cả dòng để dễ tìm, nhưng ô lỗi vẫn phải được chỉ rõ.
- [ ] Gỡ highlight và cập nhật thông báo khi người dùng sửa hợp lệ; không làm mất dữ liệu đang điền và không bật thông báo ngắt thao tác liên tục khi đang gõ.
- [ ] Kiểm tra các trường thực sự bắt buộc theo nghiệp vụ: nhà cung cấp và sản phẩm phải được chọn hợp lệ từ danh mục, không chỉ gõ tên; số lượng và đơn giá cần được điền hợp lệ. Giá trị trống/null không được tự coi là 0; đơn giá 0 hợp lệ không được coi là thiếu.
- [ ] Không tự biến ngày/số hóa đơn hoặc field OCR tùy chọn thành bắt buộc nếu chưa chốt nghiệp vụ. Backend vẫn phải kiểm tra dữ liệu dù frontend đã kiểm tra.
- [ ] Kiểm thử nhiều lỗi cùng lúc, các dòng bảng ở xa, sửa lỗi rồi xác nhận lại, và bố cục mobile/cỡ chữ lớn.
