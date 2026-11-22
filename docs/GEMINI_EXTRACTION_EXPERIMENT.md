# Thực nghiệm trích xuất Gemini với 26 ảnh

Script lấy dữ liệu ngay sau trích xuất, trước đối chiếu danh mục và hiệu chỉnh. Không khởi động web server, chạy migration, tạo phiên/hóa đơn, ghi mapping hoặc gọi KiotViet. PostgreSQL chỉ được đọc để chọn đúng tài khoản, hồ sơ cửa hàng và API key theo cơ chế hiện tại.

## Chuẩn bị

Chạy PowerShell trong backend:

```powershell
cd D:\School-related\sapi\backend
npm.cmd install
python -m pip install -r scripts/experiments/requirements-pdf.txt
```

Node dùng các dependency sẵn có. PDF cần Python 3.10 trở lên, ReportLab, Pillow và font Arial trên Windows. Nếu Python có tên khác, thêm `--python py` hoặc đường dẫn tới python.exe vào lệnh run/report. Trên máy khác có thể đặt `SAPI_PDF_FONT` tới font TTF hỗ trợ tiếng Việt.

Backend/.env và cấu hình kết nối đã lưu phải giống khi dùng SAPI: DB_*, INTEGRATION_ENCRYPTION_KEY nếu key được lưu mã hóa, GEMINI_MODEL, GEMINI_FALLBACK_MODEL, GEMINI_TIMEOUT_MS. Script gọi lại loadGeminiApiKey của ứng dụng: khi GEMINI_DEV_USE_ENV_KEY=true thì dùng GEMINI_API_KEY trong .env cho mọi tài khoản, không đọc key riêng đã lưu; khi false thì dùng key kết nối riêng của tài khoản. Không nhận key qua tham số dòng lệnh và không ghi key vào đầu ra.

### Đổi sang gateway ShopAIKey

Đặt `GEMINI_BASE_URL=https://api.shopaikey.com` (không có `/v1`) và key của gateway trong cấu hình/kết nối Gemini tương ứng. Không chỉ thay key rồi gửi đến Google. Không tự thay model để gateway chạy được; trước hết kiểm tra model 3.6/3.8 được phép trong gói đã mua.

Từ phiên bản giao thức 2, manifest ghi `settings.provider`, `settings.baseUrl` và hash module client; JSON từng ảnh cũng ghi provider/base_url. Các giá trị này không chứa key. Đổi endpoint hoặc mã nguồn làm fingerprint thay đổi và bắt buộc tạo tên lượt mới. Giữ nguyên thư mục `gemini-26` cũ, không sửa manifest để vượt kiểm tra và không chép kết quả thành công của Google sang lượt gateway.

```powershell
npm.cmd run experiment:gemini -- plan --user-id 12 --name gemini-26-shopaikey
npm.cmd run experiment:gemini -- run --user-id 12 --name gemini-26-shopaikey --limit 1 --stop-on-error
```

Sau khi kiểm tra ảnh đầu tiên và đúng cấu hình, tiếp tục với cùng `--name` và bỏ `--limit 1`. Kết quả là dữ liệu Gemini qua ShopAIKey, không mô tả là gọi trực tiếp Google; giữ riêng hai lượt trong báo cáo. Lệnh plan không gọi API. Không dùng key thật trong command line, tài liệu, tên thư mục hoặc file đầu ra.

Lượt đang dùng từ 18/11/2026: người dùng chấp thuận model chính `gemini-3.8-flash`, endpoint ShopAIKey và key chung trong `.env`. Dùng `--name gemini-26-shopaikey-38` để tách khỏi ảnh thăm dò ở `gemini-26-shopaikey` (request 3.6 nhưng gateway tự báo modelVersion 3.8). Model fallback hiện cũng là 3.8, được khử trùng trong service nên không tự chuyển về 3.6. Lịch kiểm tra 15 phút đã được xóa theo yêu cầu; chạy tuần tự ngay, không tạo vòng lặp nền.

Checkpoint 18/11/2026 (sau lượt đầu 3.8): IN-01 thành công, 10 dòng hàng, 26.343 ms; IN-02 trả HTTP thành công nhưng SDK thông báo có phần `functionCall`, không có JSON văn bản nên service ghi lỗi response rỗng và dừng đúng `--stop-on-error`. 24 ảnh còn lại chưa gọi. JSON gốc hiện có và PDF/CSV dở nằm trong `backend/experiments/gemini-26-shopaikey-38`. Không tự coi functionCall là dữ liệu hóa đơn hoặc điền bù. Giữ nguyên prompt/schema và fingerprint hiện có; nếu thay service phải dùng tên lượt mới, không sửa manifest cũ.

Chẩn đoán bổ sung được người dùng cho phép ngày 18/11/2026: gửi lại đúng IN-02, cùng ảnh/hash, prompt, schema, buyer context và model 3.8 qua service hiện tại. Lần này HTTP 200, model yêu cầu/phiên bản trả về đều `gemini-3.8-flash`, hoàn tất 10.776 ms, JSON đúng schema với 5 dòng hàng, không có functionCall. Phản hồi HTTP đầy đủ đã che key và kết quả service được lưu riêng tại `backend/experiments/gemini-26-shopaikey-38/history/IN-02-transport-diagnostic-1794972183368.json` với `diagnostic_only=true`. Không ghi đè kết quả lỗi đầu tiên; chưa thêm lần chẩn đoán vào CSV/PDF hoặc chạy ảnh khác. Lỗi functionCall cũ chưa tái lập nên không sửa parser hoặc kết luận payload functionCall cũ chứa dữ liệu hóa đơn.

### Checkpoint hoàn tất bộ ảnh ngày 18/11/2026

- Đã có JSON kết quả cho đủ 26 ảnh trong `backend/experiments/gemini-26-shopaikey-38/results`: 24 thành công về cấu trúc JSON, 2 lỗi. Đây không phải đánh giá độ chính xác OCR.
- IN-02 đã được phục hồi từ kết quả chẩn đoán thật nêu trên, giữ bản lỗi cũ trong history và nguồn gốc phục hồi trong JSON; không gọi lại ảnh này. Lượt chạy tiếp gọi đúng 24 ảnh còn thiếu, bỏ qua 2 ảnh đã thành công, không đổi prompt/schema/model.
- IN-12: HTTP 200 nhưng provider báo `MALFORMED_FUNCTION_CALL`, không có JSON hóa đơn. `results/IN-12.json` lưu cả phản hồi HTTP gốc trong `transport_responses`.
- VT-26: timeout 120.031 ms, không nhận được phản hồi HTTP hoàn tất. `results/VT-26.json` lưu lỗi timeout và các lần gọi. Không tự điền dòng hàng cho hai ảnh lỗi hoặc tự gửi lại chúng.
- Mọi request thành công yêu cầu `gemini-3.8-flash`. Gateway báo `modelVersion=gemini-3.8-flash` cho 23 ảnh, riêng VT-16 báo `gemini-3.8-flash-low`; giữ nguyên giá trị này trong metadata và PDF, không tự đổi nhãn thành model khác.
- Báo cáo cuối: `review-20261118-103815-435597.pdf` (52 trang) và `review-1794973094764-c479.csv` (153 dòng hàng). Bản review.pdf/review.csv cũ là bản dở, được giữ nguyên để không làm mất ghi chú người dùng.
- Đã kiểm tra đủ 26 điểm bắt đầu chứng từ có ảnh, đối chiếu toàn bộ giá trị CSV với JSON gốc, cột đánh giá đều trống, không lộ key, hash ảnh gốc không đổi. Đã xem ảnh render toàn bộ 52 trang và các trang chi tiết nhiều dòng/điền khung/viết tay/đặc biệt. Không chấm tự động và không ghi dữ liệu DB/KiotViet.
- Tiến trình đã kết thúc, không còn `.run.lock` và không có lịch kiểm tra 15 phút.

### Checkpoint sau khi người dùng yêu cầu thử lại IN-12 và VT-26

- Đã dùng lựa chọn chủ động `--retry-image IN-12 --retry-image VT-26 --limit 2`, giữ nguyên cấu hình và chỉ gọi đúng 2 ảnh. 24 JSON thành công khác được kiểm tra SHA-256 trước/sau và không thay đổi.
- IN-12: lần thử lại timeout 120.021 ms, chưa nhận được phản hồi hoàn tất. Lỗi `MALFORMED_FUNCTION_CALL` của lần đầu vẫn được giữ ở history.
- VT-26: lần thử lại nhận HTTP 200, modelVersion `gemini-3.8-flash`, sau 33.015 ms. JSON thiếu `supplier.address`, `invoice.date`, `items[].total_price` và có các giá trị null ở dạng chuỗi, nên bị từ chối bởi schema hiện tại. Phản hồi thô dài được giữ nguyên, không tự thêm trường/null hoặc sửa đơn giá để biến thành thành công. Bản timeout đầu tiên vẫn ở history.
- Tổng vẫn là 24/26 ảnh có JSON hợp lệ, CSV vẫn 153 dòng hàng. Bản báo cáo mới: `review-20261118-105659-192148.pdf` (55 trang do có thêm JSON lỗi nguyên văn) và `review-1794974218567-0f88.csv`. Đã kiểm tra tính toàn vẹn dữ liệu và ảnh render của các trang thay đổi; cột đánh giá vẫn trống, key không xuất hiện trong log.
- Theo tài liệu Gemini, model 3.8 hỗ trợ thinking level low/medium/high; SAPI không cấu hình thinking level trong lượt này. Chưa có xác nhận của ShopAIKey rằng hậu tố modelVersion `-low` ánh xạ chính xác thế nào; không tự gắn lại nhãn VT-16. Tham khảo: https://aistudio.google.com/docs/thinking#thinking-levels .

## Kiểm tra trước khi gọi API

Thăm dò IN-12 với prompt bổ sung kiểm tra gạch/sửa từng dòng: lượt `gemini-in12-temp1-row-check`, temperature 1.0, model 3.8, timeout 120 giây. Người dùng chỉ cho phép thêm một request; tiến trình có giới hạn cứng và xác nhận `Actual HTTP requests: 1`. Sau 12.051 ms nhận HTTP 200 nhưng response vẫn là functionCall `write_file`, JSON chứng từ nằm trong args.Content chứ không phải text. Không thực thi functionCall. JSON trong Content vẫn gồm 5 item, còn Pepsi Phúc Bồn Tử quantity 1, thành tiền 169000; Aquafina PET SL vẫn quantity 10. Thêm kiểm tra trong prompt chưa khắc phục việc đọc dấu hủy/sửa ở ảnh này. Hai vấn đề độc lập: nội dung trích xuất sai dấu hủy và định dạng trả về sai hợp đồng. Không đổi bản kết quả bộ 26 ảnh; giữ log riêng trong thư mục lượt mới.

Thăm dò riêng IN-12 sau khi người dùng chấp thuận thử temperature 1.0 ngày 18/11/2026: lượt `gemini-in12-temperature1` chạy với biến môi trường chỉ áp dụng cho tiến trình (`GEMINI_TEMPERATURE=1.0`), không sửa backend/.env. Prompt/schema/buyer/ảnh/model 3.8 và timeout 120 giây giữ nguyên. Sau 12.630 ms, HTTP 200, modelVersion 3.8, nhưng không có text: gateway trả functionCall `write_file` với args `Content`, `Path`. Không thực thi tool call hoặc ghi file theo Path do model yêu cầu. Kết quả vẫn là lỗi response rỗng; log đầy đủ trong `backend/experiments/gemini-in12-temperature1/results/IN-12.json`. Không thay kết quả của bộ 26 ảnh. Thử nghiệm này chưa chứng minh temperature là nguyên nhân duy nhất; nó chỉ cho thấy temperature 1.0 chưa giải quyết được lỗi định dạng phản hồi.

```powershell
npm.cmd run experiment:gemini -- images
npm.cmd run experiment:gemini -- users
npm.cmd run experiment:gemini -- plan --user-id 12
```

Thay 12 bằng user_id của tài khoản thực sự dùng trong SAPI. Plan hiển thị ngữ cảnh cửa hàng và model, không hiển thị key, không gọi Gemini và chưa tạo kết quả thực nghiệm.

Danh sách ảnh phải đúng 17 Giấy in, 2 Điền khung, 6 Viết tay và 1 Đặc biệt. Đặc biệt được thống kê vào nhóm Viết tay, tổng 7. Hai ảnh 13.jpg/21.jpg ở thư mục gốc không được chọn. Hiện Đặc biệt/08.jpg đã được chuyển vào Viết tay/08.jpg: script hỗ trợ đúng trường hợp chuyển chỗ này, giữ nhãn Đặc biệt và ghi đường dẫn thực vào manifest. Nếu số ảnh khác yêu cầu, script dừng thay vì tự chọn tùy ý.

## Chủ động chạy lượt thật

Với bộ ảnh phẳng trong `backend/test_images/data chính thức`, dùng tùy chọn `--dataset official` và một tên lượt riêng. Script lấy toàn bộ ảnh hỗ trợ trong đúng thư mục này, đặt mã `CT-<tên file>`, vẫn dùng nguyên pipeline, manifest, resume, JSON, CSV và PDF:

```powershell
npm.cmd run experiment:gemini -- plan --dataset official --user-id 37 --name official-20261122
npm.cmd run experiment:gemini -- run --dataset official --user-id 37 --name official-20261122
```

Không trộn lượt official với manifest bộ 26 ảnh cũ.

Lệnh sau mới gửi ảnh tới Gemini và có thể phát sinh chi phí:

```powershell
npm.cmd run experiment:gemini -- run --user-id 12 --name gemini-26
```

Chạy từng ảnh một, mỗi ảnh là một chứng từ riêng. Giữ nguyên prompt, JSON schema, ngữ cảnh bên mua, kiểm tra dữ liệu, timeout và retry/fallback hiện có. Vì giữ cơ chế retry, một ảnh có thể phát sinh nhiều request; model đã thử, model trả phản hồi và phiên bản do API báo được lưu riêng. elapsed_ms là toàn bộ thời gian xử lý ảnh, gồm cả chờ retry/fallback, không phải benchmark thời gian model thuần.

Có thể thử trước một ảnh bằng `--limit 1`. Sau đó chạy lại cùng lệnh không có limit để tiếp tục. Limit tính trên các ảnh mới được gọi trong lần chạy đó.

## Tiếp tục và tránh gọi trùng

### Chờ dịch vụ phục hồi

Sau khi gặp quá tải liên tiếp, có thể chạy mỗi 15 phút bằng lịch Codex với:

```powershell
npm.cmd run experiment:gemini -- run --user-id 12 --name gemini-26 --retry-errors --stop-on-error
```

Lượt này dùng ảnh đầu tiên chưa có kết quả thành công làm canary; đọc được thì tiếp tục tuần tự, gặp lỗi thì ngừng ngay để chờ chu kỳ sau. Retry vẫn dùng nguyên cơ chế Gemini hiện có. Chỉ lỗi tạm thời/gián đoạn được thử lại tự động; lỗi quyền, key, JSON/schema cần xem xét. Những JSON cũ được chuyển vào history, không xóa mất lịch sử; ảnh thành công không bị gọi lại. Lock cũ chỉ được chuyển vào history sau khi xác nhận PID đã chết; không giết tiến trình còn sống.

Nhịp 15 phút là lựa chọn vận hành cho tác vụ thực nghiệm không gấp, không phải giới hạn bắt buộc của Google. Không thêm vòng lặp chạy nền khác bên cạnh lịch Codex. Máy, Codex và PostgreSQL cần khả dụng để lịch tiếp tục thực hiện công việc.

### Chế độ thông thường

### Chủ động thử lại đúng ảnh lỗi được chỉ định

Sau khi người dùng chấp thuận việc gửi lại ảnh, có thể chọn chính xác từng mã:

```powershell
npm.cmd run experiment:gemini -- run --user-id 12 --name gemini-26-shopaikey-38 --retry-image IN-12 --retry-image VT-26 --limit 2
```

`--retry-image` chỉ gọi các ảnh được nêu và chưa thành công, chuyển JSON lỗi cũ vào history trước khi gọi mới. Đây là lựa chọn thử lại chủ động, kể cả trường hợp JSON/schema lỗi; không phải cơ chế retry tự động. Mọi ảnh thành công vẫn được bỏ qua, dù có tên trong tham số. Không thay prompt, schema, model hoặc manifest. `--retry-errors` thông thường vẫn chặn lỗi JSON/schema để tránh gọi lặp ngoài ý muốn. Lần thử này có thể phát sinh chi phí và báo cáo mới không ghi đè bản cũ.

### Tiếp tục thông thường

- Chạy lại cùng user_id và --name để tiếp tục các ảnh chưa có JSON. Không gọi lại ảnh đã có kết quả, kể cả kết quả lỗi.
- Manifest đóng băng prompt/schema/cấu hình/hồ sơ cửa hàng và hash ảnh. Nếu các yếu tố này đổi, dùng --name mới, không trộn cấu hình trong một lượt.
- Ctrl+C một lần sẽ đợi ảnh hiện tại được ghi xong rồi dừng. Dừng cưỡng bức có thể để lại JSON in_progress và .run.lock; không tự gọi lại request có thể đã tính phí. Kiểm tra PID trong lock, chắc chắn tiến trình cũ đã dừng rồi mới xóa đúng file lock.
- Nếu muốn thử lại riêng một ảnh lỗi/gián đoạn, lưu bản JSON cũ ra nơi khác rồi chủ động chuyển nó ra khỏi thư mục results trước khi chạy lại. Giữ nguyên manifest; việc thử lại có thể tính thêm phí. Không xóa JSON hàng loạt nếu chỉ muốn tiếp tục ảnh chưa chạy.
- Kết quả ghi sau từng ảnh. Script có lock để chặn hai tiến trình cùng ghi/gọi ảnh trong một lượt.

## Đầu ra

### Log lỗi của lượt ShopAIKey 3.8

Theo yêu cầu tiếp tục đủ 26 ảnh ngày 18/11/2026, chạy lượt `gemini-26-shopaikey-38` không có `--stop-on-error`: ảnh lỗi được giữ nguyên và tiến hành ảnh tiếp theo. Không tự gọi lại ảnh thành công hoặc dùng dữ liệu tự điền thay kết quả lỗi.

- `results/<image_id>.json` lưu trạng thái, thời gian, model, các lần gọi và thông báo lỗi. Từ lượt chạy tiếp, `transport_responses` của ảnh lỗi còn lưu HTTP status, thời điểm nhận, nội dung phản hồi thô và body JSON nếu parse được. Không lưu ảnh/base64 hoặc request chứa key; bí mật trong đầu ra được che trước khi ghi file. FunctionCall chỉ là dữ liệu log, tuyệt đối không được thực thi hoặc tự coi args là hóa đơn.
- Có thể gặp HTTP 200 nhưng `finishReason=MALFORMED_FUNCTION_CALL`: đây không phải một kết quả JSON hóa đơn hợp lệ. Giữ ảnh đó ở trạng thái lỗi, không tạo dòng hàng thay thế.
- IN-02 đã được phục hồi từ lần chẩn đoán thật đã thành công, cùng fingerprint, không gọi API thêm. Bản lỗi đầu tiên được chuyển vào `history/IN-02-first-error-*.json`; `recovery.source` chỉ rõ phản hồi dùng để phục hồi. Thời gian xử lý giữ giá trị đo thật 10.776 ms. Vì lần chẩn đoán không ghi thời điểm bắt đầu/kết thúc chính xác, hai trường đó để null thay vì tạo mốc thời gian giả.
- `scripts/experiments/verify_report.py` kiểm tra tính toàn vẹn giữa JSON, CSV, PDF và hash ảnh; không đánh giá độ đúng/sai của nội dung Gemini.

Trong `backend/experiments/gemini-26/`:

- `manifest.json`: giao thức, prompt/schema nguyên văn, cấu hình không bí mật, ngữ cảnh cửa hàng và danh sách/hash ảnh.
- `results/<image_id>.json`: dữ liệu ảnh, trạng thái, model_used/model_version, lịch sử attempts, elapsed_ms, lỗi nếu có.
- `gemini` trong mỗi JSON là JSON gốc API trả; `raw_text` giữ response text. `pipeline_result` là kết quả chuẩn hóa sau kiểm tra schema và bộ lọc bên mua hiện có, vẫn trước mapping/hiệu chỉnh. Nếu schema không hợp lệ, raw_text vẫn được giữ trong kết quả lỗi khi có thể. Bí mật bị che nếu xuất hiện trong thông báo lỗi/phản hồi.
- `review.pdf`: mọi chứng từ bắt đầu ở trang mới, có ảnh gốc đủ độ phân giải và bảng dữ liệu gốc. Chỉ đặt cạnh nhau nếu ảnh đủ lớn và dữ liệu vừa trang ở cỡ chữ 10pt; còn lại ảnh trước, dữ liệu sau. Dòng hàng dài phân trang, lặp mã ảnh và đầu bảng. null hiển thị là null, không tính tổng/đơn giá/số lượng bù.
- `review.csv`: UTF-8 BOM, dấu phẩy, CRLF, mỗi dòng tương ứng một item gốc của lần trích xuất thành công. Ảnh lỗi/chưa chạy hoặc items rỗng không sinh item giả; xem các trường hợp này trong PDF/JSON.

Thư mục experiments được gitignore vì có dữ liệu chứng từ và hồ sơ cửa hàng. Ảnh gốc không bị sửa; PDF nhúng bản hiển thị từ ảnh, áp dụng hướng EXIF nếu có. Hash ảnh được kiểm tra trước trích xuất và khi xuất PDF.

## Xuất lại báo cáo mà không gọi Gemini

```powershell
npm.cmd run experiment:gemini -- report --name gemini-26
```

Không cần đọc DB/API key khi xuất lại. Nếu PDF thất bại do thiếu dependency, JSON/CSV vẫn giữ nguyên; cài dependency rồi chạy report. Nếu đã có báo cáo, bản mới có hậu tố thời gian để không ghi đè đánh giá thủ công. Bản PDF/CSV của lượt đang chạy dở vẫn thể hiện đầy đủ 26 ảnh ở PDF, với trạng thái chưa chạy cho phần còn lại.

## Đánh giá trong Excel

### Bản tổng hợp lịch sử lỗi IN-12 và VT-26 (18/11/2026)

Theo yêu cầu bổ sung cả hai chứng từ từng lỗi, đã xuất bản `backend/experiments/gemini-26-shopaikey-38/review-with-error-history-20261118-173147.pdf`: 60 trang, 52 trang kiểm tra đủ 26 ảnh và phụ lục lịch sử lỗi từ trang 53. Không ghi đè các PDF/CSV đã có; không gọi lại Gemini.

- Trạng thái bộ kết quả hiện tại: **25 kết quả hợp lệ về schema, 1 lỗi (VT-26)**. Đây không phải tỷ lệ chính xác OCR. IN-12 từng lỗi `MALFORMED_FUNCTION_CALL` và timeout, nhưng kết quả mới nhất đã được service chấp nhận; lịch sử cũ vẫn được giữ nguyên.
- Phụ lục chứa 7 bản ghi của IN-12 và VT-26: lịch sử trong lượt chính, kết quả hiện tại và hai lượt chẩn đoán IN-12 với temperature 1. Hai lượt chẩn đoán khác cấu hình được ghi nhãn riêng, không trộn vào mẫu 26 ảnh.
- `error-evidence-20261118-173147/` chứa 15 file bằng chứng: bản sao record JSON, nguyên văn HTTP body khi log có lưu, nguyên văn model text khi có, README và chỉ mục SHA-256. Các file này cũng được nhúng dưới dạng attachment trong PDF. Phản hồi dài chỉ trích đoạn có nhãn trong PDF; file TXT giữ nguyên toàn bộ chuỗi, kể cả phần thập phân dài của VT-26. Không làm tròn, sửa hoặc tự tính bù.
- Timeout không có body HTTP trong log được ghi rõ **không có phản hồi được lưu**, không tự dựng phản hồi. Thông báo lỗi của SAPI được tách khỏi nội dung nhà cung cấp trả về.
- Đã kiểm tra hash toàn bộ 26 ảnh, đối chiếu CSV gần nhất (156 dòng hàng, cột đánh giá còn trống), kiểm tra attachment trong PDF bằng byte và xác nhận các record gốc không thay đổi. Đã render/kiểm tra bố cục các trang phụ lục và trường hợp phản hồi dài.

Xuất lại từ log đã lưu, không gọi API: `python scripts/experiments/export_error_review.py --run-dir experiments/gemini-26-shopaikey-38` (chạy tại `backend`, cần dependency PDF đã nêu). Mỗi lần tạo tên đầu ra mới để giữ các bản cũ.

Mở bằng Data → From Text/CSV, chọn UTF-8 và delimiter Comma. Đặt các cột dữ liệu gốc là Text để giữ số 0 đầu mã chứng từ, số điện thoại, ngày và chuỗi bắt đầu bằng =/+/-. Không mở dưới dạng công thức hay tự chuyển ngày: CSV lưu nguyên giá trị và không tự thêm ký tự vào kết quả Gemini. JSON là bản gốc đối chiếu khi Excel tự đổi kiểu.

- image_id và item_no đối chiếu trực tiếp với PDF; group là nhóm thống kê, kind tách trường hợp Đặc biệt.
- Các cột dữ liệu gốc giữ nguyên kết quả. Các cột *_review, *_actual, row_review, notes đều để trống cho người kiểm tra.
- Điền ĐÚNG/SAI/THIẾU cho từng *_review; row_review có thể ghi THỪA khi Gemini đọc dư. Đây là quy ước nhập tay, script không tự đánh giá.
- Nếu bỏ sót hàng, tự thêm dòng: giữ image_id, ghi item_no như BS-01, ghi THIẾU vào row_review, điền thông tin thật vào *_actual. Để trống các field Gemini vốn không đọc được. Không sửa JSON gốc.

## Kiểm thử script không gọi API

```powershell
python -m pip install pypdf
npm.cmd run test:gemini-experiment
```

Self-test vô hiệu hóa mạng, thay SDK trong tiến trình kiểm thử và dùng fixture được đánh dấu rõ. Không chấm ảnh thật. Nó kiểm tra việc dùng lại prompt/schema/context, metadata fallback, raw/pipeline, danh sách 26 ảnh, chạy tuần tự/resume, che key trong lỗi, từ chối cấu hình khác, BOM/quote/null, bảo vệ CSV đã sửa, xuất PDF và hash ảnh gốc. Đầu ra ở `experiments/selftest-gemini-*/`, không dùng thư mục này làm kết quả nghiên cứu. PDF kiểm thử có nhãn giả lập trên từng trang.
