# Fulfillment Performance

Ngày 11/05/2026. Dashboard đo vòng đời đơn hàng. Đặt tại `/fulfillment/performance`.

## Vì sao làm

Chủ shop chưa có con số để biết đơn tắc ở đâu và nên tối ưu khâu nào. Đo thử 30 ngày qua cho thấy: đặt hàng → duyệt design trung vị 101 giờ, chỉ 17% đạt mốc 1 ngày, trong khi có file → duyệt chỉ 10 giờ. Khâu chậm nhất là đặt hàng → có file. Những con số này trước đây không ai nhìn thấy.

Dashboard phải trả lời: khâu nào đang chậm, chậm ở nhóm nào, lỗi hàng và khiếu nại ở mức nào, và hôm nay có những đầu việc nào cần kiểm tra.

Chủ shop chốt phạm vi này và sẽ chỉnh dần sau khi có số thật, nên bước đầu ưu tiên số trung thực, chưa cần đủ mọi góc nhìn.

## Mục tiêu

1. Thời gian từng khâu, mốc 7 ngày và 30 ngày.
2. Tỷ lệ ticket trên đơn, tỷ lệ hàng lỗi hoặc sai, mốc 7 ngày và 30 ngày.
3. Danh sách việc cần kiểm tra **gom theo đầu mục**, mỗi đầu mục một dòng có số lượng, bấm vào mới thấy danh sách đơn.

## Không làm ở bước này

- Không làm lại phần shipping. Dùng số có sẵn từ `computeSupplierPerformance`.
- Không sửa dữ liệu đơn, không tự xử lý đầu việc. Dashboard chỉ đọc, ngoại trừ cột `doneAt` mô tả bên dưới.
- Không gửi cảnh báo qua email hay chat.
- Không đặt mục tiêu cho khâu gửi xưởng và các khâu sau. Chỉ hiện số đo. Chủ shop đặt sau khi xem số thật.
- Không dựng bộ lọc theo thời gian tuỳ ý, chỉ 7 và 30 ngày.
- Không thêm thư viện biểu đồ. Dùng `components/cs/Bars.tsx` và SVG như các trang hiện có.

## Điều tuyệt đối tránh

- Con số đẹp giả: chỉ tính dòng đã xong làm tuần gần nhất trông rất tốt. Tuần 45 đo thử ra 79% đạt 24 giờ chỉ vì dòng khó chưa xong chưa được đếm. Mọi tỷ lệ đạt mốc phải tính cả dòng chưa xong đã quá hạn.
- Gọi route `GET /api/fulfillment/task-fix` từ dashboard, vì route đó ghi `OrderTaskState`.
- Tải nặng làm chậm VPS. Không quét toàn bộ nhật ký task mỗi lần mở trang, không gọi Google hay Merchize khi mở trang.
- Trình bày phân loại do AI gán như sự thật chắc chắn. Số lỗi hàng phải ghi rõ nguồn là phân loại AI.

## Định nghĩa số đo

Mỗi số đo tính trên **dòng sản phẩm**, không tính add-on (`isNonProductLine`). Bỏ đơn huỷ và hoàn tiền toàn phần, bỏ task CANCELLED.

**Nhóm thời gian:** theo **ngày đặt hàng** (`Order.placedAt`) nằm trong 7 hoặc 30 ngày gần nhất. Thời gian tính theo giờ thực tế, gồm cả cuối tuần (Claude quyết định).

| Khâu | Từ | Đến | Mục tiêu |
|---|---|---|---|
| Có file | `placedAt` | `min(DesignArtwork.createdAt)` với `kind='PRINT'` | chưa có |
| Duyệt | file in đầu tiên | `DesignTask.doneAt` | chưa có |
| Design tổng | `placedAt` | `DesignTask.doneAt` | **24 giờ** (chủ shop chốt) |
| Gửi xưởng | `doneAt` | `OrderLine.exportedAt` | chưa có |
| Vận chuyển | theo `computeSupplierPerformance` | | chưa có |

- **Hiển thị mỗi khâu:** trung vị, p90, số dòng.
- **Khâu Design tổng hiển thị thêm:** % đạt 24 giờ và số dòng đang trễ. Công thức % đạt = dòng xong trong 24 giờ ÷ (mọi dòng trong nhóm có tuổi từ 24 giờ trở lên, xong hay chưa). Dòng chưa đủ 24 giờ tuổi chưa được tính vào mẫu số.
- **Task mở lại:** thời gian tính theo **lần duyệt cuối** (chủ shop chốt). Số lần mở lại đếm riêng, hiển thị % dòng từng bị trả lại.
- **Dòng thư viện** (`fromLibrary`) và dòng link từ ngoài: tách khỏi Design tổng vì thời gian của chúng là chờ quét, không phải công làm. Hiện thành số riêng.
- **Dữ liệu cũ:** đơn không có task (trước 10/09) không vào số đo design.
- **Dòng xuất trước khi duyệt** (`exportedAt < doneAt`, 30 dòng trong đo thử): không vào số đo Gửi xưởng, đưa vào đầu mục kiểm tra.
- **Tách nhóm:** mức sẵn sàng (Auto, Cần chỉnh, Làm tay), custom hay không, xưởng (Gửi xưởng, Vận chuyển), loại sản phẩm.
- **Xu hướng:** biểu đồ theo tuần đặt hàng cho Design tổng, tuần chưa trọn đánh dấu rõ.

## Ticket và lỗi hàng

Nguồn `CsTicket`, theo `fdCreatedAt`. Dùng `CsTicket.category`, không dùng phân tích mới nhất vì nó có thể mất nguyên nhân khi phân tích lại.

- **Tỷ lệ ticket:** ticket mở trong kỳ, bỏ `SPAM`, ÷ số đơn đặt trong kỳ.
- **Tỷ lệ lỗi hoặc sai:** ticket `WRONG_ITEM`, `DAMAGED_OR_DEFECTIVE`, `MISSING_ITEM` ÷ số đơn đặt trong kỳ. `PERSONALIZATION_ISSUE` là yêu cầu đổi trước sản xuất, tính riêng, không tính lỗi.
- **Theo loại:** số ticket theo từng category, kể cả chưa phân loại.
- **Theo xưởng và sản phẩm:** chỉ tính được trên ticket đã gắn đơn. Phải hiện rõ tỷ lệ đã gắn (hiện chỉ khoảng 42%).
- **Ticket chỉ có từ 10/15/2026:** khi kỳ 30 ngày dài hơn dữ liệu, mẫu số chỉ đếm đơn từ ngày có ticket đầu tiên và ghi rõ trên màn hình.

## Đầu mục cần kiểm tra

Mỗi đầu mục một dòng: tên, số lượng, mức độ, nơi xử lý. Bấm vào mở danh sách (tối đa 100, có link sang task hoặc đơn). Đầu mục 0 thì ẩn hoặc chuyển xuống cuối.

Tính ngay khi mở trang, từ DB:
1. Design trễ quá 24 giờ, tách Auto và Làm tay.
2. Đã duyệt nhưng chưa gửi xưởng quá lâu. Vì chưa có mục tiêu nên tạm dùng 48 giờ (Claude quyết định).
3. Dòng chưa mapping.
4. Task thư viện chờ quét.
5. Dòng xuất trước khi duyệt.
6. Dấu đã xuất Merchize mà không có đơn API (hiện 10 đơn).
7. Task bị trả lại đang mở.
8. Đơn đã gửi nhưng chưa có tracking sau 7 ngày.
9. Ticket chưa gắn đơn, ticket chưa phân loại.
10. Các mục của Need To Fix: dùng `listOrderTasks`, gom theo loại, không ghi `OrderTaskState`.

Cần đọc nguồn ngoài, chạy theo lịch hoặc bấm tay, lưu kết quả, không chạy khi mở trang:
11. Đã xuất nhưng không có trong sheet xưởng. Đọc sheet Jomall, tận dụng `collectKeys` để nhận mọi kiểu mã. Hiện thời điểm quét gần nhất. Mango cần thêm ID sheet.

## Thay đổi dữ liệu

Thêm cột `DesignTask.doneAt DateTime?`:
- Ghi khi task sang DONE ở mọi đường: duyệt, chuyển sang sản xuất, sync link ngoài, sync dòng đã gửi.
- Lần duyệt sau ghi đè. Khi task mở lại khỏi DONE thì xoá về null.
- Điền ngược từ `DesignTaskEvent`: lấy sự kiện duyệt cuối cùng theo các mẫu `Duyệt design`, `Chuyển sang sản xuất`, `Dòng đã gửi xưởng`, `ngoài studio`, và `→ DONE` cho log cũ. Không tìm được sự kiện thì để null, không đoán bằng `updatedAt`.
- Backfill chạy bằng script có chế độ thử, thử trên bản sao DB trước, sao lưu DB trước khi chạy prod.

Sửa kèm `src/lib/cs/timeline.ts` dùng `doneAt`, vì regex hiện tại không còn khớp log mới và test đang dùng log cũ nên không phát hiện. Đây là lỗi có sẵn.

## Giao diện (Claude quyết định)

Theo mẫu `app/cs/insights/page.tsx`. Thứ tự từ trên xuống:
1. Chọn 7 ngày / 30 ngày, bộ lọc xưởng.
2. Chuỗi khâu dạng các ô nối nhau, mỗi ô có trung vị và p90, khâu chậm nhất được đánh dấu.
3. Ô mục tiêu: % đạt 24 giờ và số dòng đang trễ, biểu đồ theo tuần.
4. Tách theo nhóm: mức sẵn sàng, xưởng, loại sản phẩm, dạng bảng.
5. Ticket và lỗi hàng.
6. Đầu mục cần kiểm tra.

Không tối ưu điện thoại, theo yêu cầu chủ shop.

## Quyền và kỹ thuật

- Trang kế thừa quyền `fulfillment_dashboard` theo đường dẫn.
- API `/api/fulfillment/performance` cần thêm luật trong `api-access.ts` kèm test, vì không có luật thì mọi người trừ SUPERADMIN bị chặn.
- Thêm mục "Performance" vào nhóm Fulfillment trên sidebar.
- Hàm tính thuần tách khỏi truy vấn, test bằng dữ liệu mẫu theo kiểu `supplier-performance.test.ts`, kèm test tích hợp route theo kiểu `cs-insights.integration.test.ts`.
- Không có schema change nào khác ngoài `doneAt`. Deploy phải dừng app để migrate.

## Thứ tự làm

1. `doneAt`: cột, ghi ở mọi đường, backfill, sửa timeline CS.
2. Số đo thời gian và trang dashboard.
3. Ticket và lỗi hàng.
4. Đầu mục kiểm tra từ DB.
5. Đầu mục cần đọc sheet.

Mỗi bước deploy riêng, đều cần chủ shop đồng ý.

## Những gì Claude quyết định thay chủ shop

- Tính theo giờ thực tế, gồm cả cuối tuần.
- Nhóm theo ngày đặt hàng, không theo ngày hoàn thành.
- Mốc 48 giờ cho đầu mục "chưa gửi xưởng".
- Tính lỗi hàng gồm `MISSING_ITEM`, không gồm `PERSONALIZATION_ISSUE`.
- Bỏ đơn hoàn tiền toàn phần khỏi số đo thời gian.
- Dòng thư viện tách riêng khỏi Design tổng.

## Để người làm tự quyết

Cách viết truy vấn, cache ngắn cho trang nếu cần, cách chia component, câu chữ trên màn hình.

## Câu hỏi còn mở (đọc lại thiết kế 11/05/2026, chưa hỏi chủ shop)

Đếm trên bản sao prod 11/05, đơn đặt từ 10/06. Việc này đang tạm gác, chưa chốt câu nào.

1. Trung vị và p90 có tính dòng chưa xong không? Chỉ tính dòng đã xong thì số đẹp giả, 112 task trong nhóm 30 ngày còn mở.
2. Ô Vận chuyển hiện gì? `computeSupplierPerformance` chỉ có trung bình và theo ngày giao, còn thiết kế muốn trung vị theo ngày đặt. 986 đơn đã fulfill chỉ 401 đơn có Shipment. Chưa đo khâu xưởng sản xuất (xuất → scan đầu).
3. Tách nhóm theo mức sẵn sàng lúc tạo task hay hiện tại? `submitAutoRenderForReview` ghi đè thành AUTO, nên nhóm Auto có thể gồm dòng từng là Làm tay. Muốn giữ giá trị đầu cần thêm một cột, phải quyết trước migration.
4. "Xuất trước khi duyệt": 30 dòng gồm 10 chưa duyệt lúc xuất, 20 duyệt, xuất, rồi mở lại và duyệt lại. Nhóm 20 có thể xưởng đang giữ file cũ, cần tách riêng bằng cách đọc sự kiện.
5. 177 dòng đã mapping có link nhưng không có task, sau 10/09, nằm ngoài mọi khâu. Có đưa vào số riêng không?
6. "Từng bị trả lại" gồm gì? 45 từ chối, 66 mở lại từ DONE, gộp 108 (6,5%). 43 sự kiện mở lại không có người làm, có vẻ do script ngoài, các script đó sẽ không xoá `doneAt`, nên chỉ tin `doneAt` khi task đang DONE.
7. "Chưa có tracking" ở đầu mục 8: không có Shipment là 747 đơn, chưa fulfill trên Shopify là 162. 585 đơn còn lại đã fulfill mà không có Shipment, đây có thể là vấn đề riêng.
8. Đầu mục kiểm tra theo bộ lọc 7/30 ngày và xưởng, hay luôn hiện mọi thứ đang mở? Mục 5 và 6 không xoá được nên có thể không bao giờ về 0.
9. Luật của "Merchize đã xuất mà không có đơn API": không tái tạo được số 10 (40 đơn nếu không giới hạn, 7 nếu từ lần push đầu và đang EXPORTED). Áp dụng từ ngày nào?
10. Mốc 24 giờ có áp dụng cho dòng không custom không? Setting prod `slaNonCustomHours` là 48, 256 task đang mang mốc 48 giờ, khoảng 15% sẽ báo trễ trên dashboard dù đúng hạn trong Design Studio.
