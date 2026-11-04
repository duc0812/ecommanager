# Duyệt sản xuất thành hub đẩy đơn theo xưởng

Ngày 11/04/2026. Bước đầu: giao diện chia theo xưởng và đẩy tự động vào sheet Jomall.

## Vì sao làm

Chủ shop muốn "Duyệt sản xuất" không chỉ để kiểm tra, mà là nơi đẩy đơn sang xưởng luôn. Bấm sản xuất ở xưởng nào thì đơn vào đúng kênh của xưởng đó, không tải CSV rồi dán tay.

Dán tay đang gây lỗi thật: có dấu đã xuất mà xưởng không có đơn (10 đơn Merchize, 20 dòng Jomall chưa rõ), mã dòng ghi nhiều kiểu, cột bị sửa tay sau khi xuất.

## Mục tiêu

1. Màn "Duyệt sản xuất" chia theo xưởng, card một kích thước cố định, dùng được trên điện thoại.
2. Xem chi tiết bằng cách bấm vào card để mở task, card không chứa chi tiết.
3. Khu Jomall có nút "Sản xuất" ghi đơn thẳng vào sheet Jomall, đúng cấu trúc, không trùng.
4. Cấu hình sheet theo từng xưởng, để sau thêm Mango mà không phải viết lại.

## Không làm ở bước này

- Không làm kênh sheet cho Mango và các xưởng khác. Mango là bước kế tiếp, sau khi Jomall chạy ổn.
- Không đổi luồng API của Merchize và PGprints (xem trước, xác nhận, hash).
- Không đổi tab "Đã chuyển xưởng", trừ việc hiển thị kênh Sheet.
- Không tự sửa 10 đơn Merchize mang dấu CSV và 20 dòng Jomall chưa rõ. Đó là việc riêng.
- Không xử lý tracking mới. Auto Fulfill vẫn đọc tracking từ sheet như cũ.

## Điều tuyệt đối tránh

- Ghi đè, sửa hoặc xoá dòng đã có trong sheet của Jomall. Sheet không thuộc sở hữu của mình.
- Đánh dấu đã xuất khi chưa đọc lại được dòng trong sheet.
- Gửi trùng một dòng vì bấm hai lần, vì đã có người dán tay, hoặc vì dòng được chép sang tab khác.
- Đổi quyền Drive đang dùng để tải file in, hoặc làm Drive phải kết nối lại.

## Giao diện (Claude chọn, chủ shop giao quyền chọn)

Chủ shop đang dùng điện thoại nên giao mình chọn một mẫu.

**Thanh xưởng.** Hàng tab ở trên cùng, dính khi cuộn, cuộn ngang được trên điện thoại. Mỗi tab có tên xưởng và số đơn chờ. Xưởng nhiều đơn đứng trước, xưởng 0 đơn ẩn. Có thêm tab "Chưa map xưởng" khi có đơn loại này. Không có tab "Tất cả". Tab đang chọn giữ theo URL hoặc lưu ở trình duyệt.

**Đầu mỗi tab.** Tên xưởng, nhãn kênh (API, Sheet hoặc CSV), số đơn, số đơn có cảnh báo. Kênh Sheet có nút "Sản xuất tất cả (N)", không tính đơn có cảnh báo. Kênh CSV có link sang trang CSV Export.

**Một card** là một cặp đơn và xưởng. Đơn nhiều xưởng xuất hiện ở mỗi tab, chỉ tính các dòng chưa gửi của xưởng đó.

Mọi card cùng chiều cao cố định, khoảng 148px, và một cột trên điện thoại:

```
┌───────────────────────────────────────┐
│ ┌──────┐  LIT5873_1            US  ⚠  │
│ │ ảnh  │  Tên sản phẩm một dòng…      │
│ │mockup│  Youth L · SL 1              │
│ └──────┘  Tên in: Allyssa             │
│ 10/31            +1 dòng   [Sản xuất] │
└───────────────────────────────────────┘
```

- Ảnh là mockup của dòng đầu, cắt vuông.
- Chữ dài cắt bằng dấu "…", không làm card cao lên.
- Đơn nhiều dòng hiện dòng đầu kèm "+N dòng".
- Bấm vào card mở task của dòng đầu. Bấm nút thì không mở task.
- Card có cảnh báo: viền đỏ, biểu tượng ⚠, chạm vào mở task để sửa.
- Ở kênh Sheet, cảnh báo tắt nút "Sản xuất" vì ghi sheet không có bước xem trước. Ở kênh API và CSV, cảnh báo chỉ để nhìn, nút và các kiểm tra hiện có giữ nguyên.
- Thông tin bỏ khỏi card: link Drive, SKU, danh sách file, chi tiết cảnh báo. Những thứ này xem trong task.

Task phải hiện được lý do cảnh báo mà card bỏ đi: sai khổ file, xưởng lệch mapping, thiếu mockup. Nút "Cập nhật xưởng theo mapping" chuyển vào đó.

Giới hạn 60 card hiện tại phải được áp theo từng xưởng, và số trên tab phải là số thật dù vượt giới hạn.

## Kênh của từng xưởng

| Xưởng | Kênh | Nút trên card |
|---|---|---|
| Merchize, PGprints | API | Mở cửa sổ gửi hiện có |
| Jomall | Sheet | Sản xuất, có hộp xác nhận |
| Các xưởng khác | CSV | Lưu chờ xuất CSV như hiện tại |

PGprints thiếu khoá hoặc SKU API thì vẫn rơi về CSV như hiện tại. Merchize không có CSV.

Khi kênh Sheet của một xưởng đang bật, CSV Export của xưởng đó bị từ chối, giống cách đã làm với Merchize, vì hai đường song song sẽ tạo đơn trùng. Việc "Lưu chờ xuất CSV" cũng bị từ chối khi đơn còn dòng chưa gửi của xưởng kênh Sheet, kể cả đơn nhiều xưởng, vì đơn đã lưu sẽ rời khỏi hub.

Trước khi bật, kiểm tra đơn của xưởng đó đang ở trạng thái đã lưu chờ CSV. Ngày 11/04 Jomall có 0 đơn như vậy. Nếu lúc bật có đơn, hoàn tác lưu cho chúng để quay về hub.

Bước đầu mọi đơn Jomall đều thuộc store Litzzy (`caramiaus-store`, 1.061/1.061 dòng trong 60 ngày). Cấu hình kênh ghi rõ store được phép, dòng của store khác không được ghi và bị báo lỗi, vì dữ liệu khách đã ghi thì tool không xoá được.

## Cấu trúc sheet Jomall (đã đọc thật ngày 11/04/2026)

- Spreadsheet `1O4KzqYOdfS7CQ1v3k0oUqeGDTRJWxFBioPwO59F1ips`, "Order Delta Ecom - Jomall".
- Mỗi tháng một tab tên `ORDER <tháng>-<năm>`, ví dụ `ORDER 11-2026`. Tháng không có số 0 đứng đầu. Ngoài ra có `Temp`, `Tracking Check`, `Price($)`, `Size Chart`, `BILL`, `Draft`.
- Hàng 1 là tiêu đề. Cột A có tiêu đề toàn dấu cách, chứa ngày.
- Từ tab tháng 9, cột `SKU COLOR` đổi thành `Custom Name`. Vị trí cột từng lệch giữa các tháng, nên **luôn map theo tên tiêu đề, không theo vị trí**.

### Map cột khi ghi

| Cột sheet | Nguồn | Ghi chú |
|---|---|---|
| A (không tên) | Ngày gửi, `M/D/YYYY`, giờ Việt Nam | 91/126 dòng đã so khớp là ngày xuất, không phải ngày đặt |
| Order Number | `#LIT123_1` | **Luôn có hậu tố dòng**. Dòng không hậu tố làm Auto Fulfill hiểu là cả đơn |
| Order Vendor | `LIT123` | Khớp kiểu đang có 42/163 dòng của tháng 11 |
| Phone, Name, Address, City, State, Postcode, Country | Đơn hàng | Như template CSV hiện tại |
| SKU | `baseSku` của phôi | Xem mục Câu hỏi còn mở |
| SKU Custom | SKU của dòng | Khớp 126/126 |
| Item Name | Như template hiện tại (`line.itemName`) | |
| Type | Tên sản phẩm phôi | Sheet đang gõ hơi khác ("3D Hoodies" và "3D HOODIE"), chấp nhận |
| Size | Xem quy tắc bên dưới | |
| Color | `variant2Value` của phôi | Khớp 125/126 |
| Custom Name | Thông tin custom của dòng, nối bằng `, ` nếu nhiều giá trị | 44/74 dòng khớp trực tiếp, cần soi 30 dòng còn lại khi làm |
| design note | Ghi chú sản xuất của dòng | |
| Quantity | Số lượng | |
| mockup link | Như CSV hiện tại | |
| Design link | Như CSV hiện tại (`resolveExportDesignLinks`) | |

Không bao giờ ghi vào: `Customer Note`, `SKU COLOR`, `Design Back`, `process`, `Facility`, `Price$`, `Tracking`, `Lastmile tracking number`, `Lastmile Carrier`, `Tracking ( NEW)`, `Notes`, `logistics website`. Các ô này phải để trống, không ghi chuỗi rỗng đè công thức nếu có.

**Quy tắc Size.** `variant1Value` của phôi không phải lúc nào cũng là size: 29/126 dòng lệch, ví dụ phôi ghi `Pullover Hoodie` còn sheet ghi `XL`, phôi ghi `Full Set` còn sheet ghi `Full Set / L`. Cột này là chữ tự do, tháng 9 đến 11 có 91 giá trị khác nhau (`Kid 8Y`, `Adult`, `One Size`, `40OZ`, `Queen (90" x 90")`), nên không có danh sách size hợp lệ.

Người làm chọn quy tắc dựa trên `variantTitle` của đơn và `variant1Value`, rồi chạy thử trên các dòng lịch sử có thể ghép với prod của 3 tháng này và báo tỉ lệ khớp trước khi bật. Không tìm được size thì để trống và vẫn gửi được, vì sheet đang có dòng trống và sản phẩm không có size không có cách sửa trong task.

## Bấm Sản xuất

1. Hộp xác nhận hiện số dòng và tên tab sẽ ghi.
2. Kiểm tra từng dòng: đơn còn mở, task xong, có link thiết kế và mockup, không có cảnh báo, chưa có dấu đã xuất. Link thiết kế theo đúng cách CSV đang lấy, nên design từ ngoài studio có link http vẫn hợp lệ. Có mockup nghĩa là có file MOCKUP đã tải lên hoặc `previewCdnUrl`. Chỉ có `imageUrl` thì chưa đủ, vì đó có thể là ảnh chính của sản phẩm, không phải đúng biến thể.
3. Đọc hàng tiêu đề của tab tháng hiện tại. Thiếu tab hoặc thiếu cột cần ghi thì **dừng cả lượt và báo**, không tự tạo tab, không ghi. Có thêm cột lạ thì vẫn ghi, vì map theo tên.
4. Đọc cột `Order Number` và `Order Vendor` của tab hiện tại và hai tab tháng liền trước. Chuẩn hoá về một khoá dòng, nhận được các kiểu `LIT123-1`, `LIT123_1`, `#LIT123_1` và `#LIT123` đi với `LIT123_1`. Dòng đã có thì không ghi lại, đánh dấu đã xuất và báo là "đã có sẵn".
5. Một dòng đơn lẻ không có hậu tố ở cả hai cột (`#LIT123` và `LIT123`) khớp với mọi dòng của đơn đó, để an toàn.
6. Ghi các dòng mới vào cuối bảng bằng kiểu chèn hàng mới, không đè ô có sẵn.
7. Đọc lại đúng các hàng vừa ghi, so với dữ liệu gửi. Khớp mới gọi `markOrdersExported` với `lineIds` và ghi nhật ký. Không khớp thì không đánh dấu và báo rõ hàng nào.
8. Kết quả báo theo từng dòng: đã ghi, đã có sẵn, lỗi. Lỗi một dòng không làm hỏng các dòng khác, trừ lỗi ở bước 3.

Khoá chống bấm hai lần: mỗi lượt theo xưởng chỉ chạy một lúc, và mỗi lần ghi có một bản ghi trạng thái (đang ghi, đã ghi, lỗi) cho từng dòng. Nếu máy chủ chết giữa chừng, lượt sau quét sheet ở bước 4 nên không ghi trùng.

Ghi xong không có nút hoàn tác trên sheet. Muốn huỷ thì người vận hành xử lý với Jomall, rồi xoá dấu đã xuất như hiện tại.

Bước đầu không có nút gửi lại bỏ qua chống trùng. Làm lại một dòng thì dùng mã mới có chữ R như đang làm (`LIT123_1R`), và chuẩn hoá khoá phải coi đó là dòng khác.

Bước 5 là cách xử lý thận trọng, có thể bỏ sót dòng chưa gửi của đơn cũ. Khi đó dòng hiện "đã có sẵn" và người vận hành thấy trong báo cáo.

## Quyền Google

Tool hiện dùng OAuth quyền `drive.file`, không đọc ghi được sheet của người khác, và token của chủ sheet không có.

- Thêm **kết nối riêng** cho Google Sheets, quyền `spreadsheets`, lưu khoá riêng, không đụng kết nối Drive.
- Chủ shop đăng nhập bằng tài khoản có quyền edit sheet. Nên là tài khoản vận hành, vì quyền này áp dụng cho mọi sheet của tài khoản đó.
- Trong Google Cloud phải bật Sheets API và thêm quyền cho màn hình đồng ý. Người làm kiểm tra app đang ở chế độ Testing hay Production, vì chế độ Testing làm token hết hạn sau 7 ngày.
- Token hỏng thì nút Sản xuất báo cần kết nối lại, không rơi về CSV.

Cấu hình kênh theo xưởng lưu trong dữ liệu (spreadsheet, mẫu tên tab, bản đồ cột), không viết cứng cho Jomall.

Việc ghi sheet chạy ở máy chủ, route mới phải có access rule theo `API_ACCESS_RULES` và dùng `canHandoffToSupplier`.

## Thử nghiệm và ra mắt

1. Test tự động dùng Sheets API giả: map cột, chuẩn hoá khoá, tiêu đề đổi, thiếu tab, đọc lại sai, bấm hai lần.
2. Kiểm tra `build-fulfill-plan` và `parse-sheet` đọc đúng dòng `#LIT123_1` do tool ghi.
3. Chạy thử trên bản sao chỉ có tiêu đề, trong Drive của tài khoản vận hành, không có dữ liệu khách.
4. Dòng thật đầu tiên trên sheet Jomall chỉ gửi khi chủ shop đồng ý, xem lại ngay trong sheet.
5. Giao diện kiểm tra ở 375px và desktop: mọi card bằng nhau, không tràn ngang.

Deploy theo quy trình VPS hiện tại. Có thay đổi schema thì sao lưu DB và dừng app trước khi migrate.

Báo nhân sự đang dán CSV cho Jomall trước khi bật, vì hôm nay vẫn có người xuất tay (số đơn Jomall chờ giảm từ 33 về 0 trong lúc khảo sát).

## Những gì Claude quyết định thay chủ shop

- Mẫu giao diện: tab trên cùng, card cố định, một card cho mỗi cặp đơn và xưởng.
- Gửi hàng loạt chỉ có ở kênh Sheet. API vẫn gửi từng đơn vì có phí và cần xem trước.
- `Order Number` luôn có hậu tố dòng, kể cả đơn một dòng.
- Tab ghi theo ngày gửi, giờ Việt Nam.
- Quét trùng ở tab hiện tại và hai tab trước.
- Thiếu tab tháng thì dừng và báo, không tự tạo.
- Bật kênh Sheet thì khoá CSV của xưởng đó.
- Thiếu mockup chặn gửi ở kênh Sheet, theo quy tắc mọi dòng phải có mockup. Kênh API và CSV giữ nguyên.
- Thiếu size vẫn gửi được, để trống cột Size.
- Không có nút gửi lại bỏ qua chống trùng, làm lại dùng mã có chữ R.
- Đơn của store khác bị từ chối ở kênh Sheet Jomall.

## Để người làm tự quyết

Cách lưu cấu hình và nhật ký ghi (bảng mới hoặc dùng bảng hiện có), cách chia component, cách phân trang theo xưởng, thư viện gọi Sheets API, cách chia nhỏ hậu tố trong test.

## Câu hỏi còn mở

- Cột `SKU`: template điền `baseSku`, nhưng sheet có 91/126 dòng bỏ trống dù phôi có mã. Tạm thời ghi `baseSku`.
- 65 dòng nằm ở cả tab tháng 10 và 11: chủ shop trả lời "Okie" cho cả bản tóm tắt, chưa nói rõ có phải chủ ý hay không. Thiết kế chịu được cả hai trường hợp nhờ quét trùng nhiều tab.
- Tài khoản Google nào có quyền edit sheet Jomall, và ai vào được Google Cloud. Tool hiện kết nối Drive bằng `setads001@gmail.com`. Quyền `spreadsheets` là quyền nhạy cảm, nên nếu app đang ở chế độ Testing thì chuyển chế độ có thể phải qua màn cảnh báo app chưa xác minh. Điều này quyết định dùng chung OAuth client hay tạo client riêng.
