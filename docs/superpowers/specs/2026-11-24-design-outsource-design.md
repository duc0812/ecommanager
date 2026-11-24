# Design Outsource trong Design Studio

Ngày: 24/11/2026. Trạng thái: đã được người dùng đồng ý triển khai; đã có mã nguồn và migration ở local, chưa áp dụng vào dữ liệu đang chạy hoặc đưa lên server.

Design Outsource là nơi designer bên ngoài xử lý những task được nội bộ chuyển sang. Người làm nhận yêu cầu, tải template từ Drive, làm mẫu, upload file và gửi duyệt ngay trong tool. Tên sản phẩm, store và dữ liệu kinh doanh không xuất hiện trong tài khoản outsource.

## Phạm vi và giả định

Yêu cầu đã có: thêm mục Design Outsource trong Design Studio; thao tác gần giống Design Tasks; loại thông tin nhận diện sản phẩm và store; bổ sung link download template Drive.

“Chuyển qua” là nội bộ chọn task hiện có rồi giao outsource. Mỗi outsource chỉ thấy task được giao đích danh theo phương án người dùng đã đồng ý. Chưa bao gồm tính công, thanh toán hoặc bảng KPI outsource.

## Luồng giao việc và làm mẫu

1. Trong Design Tasks, leader chọn một hoặc nhiều task rồi bấm **Chuyển outsource**.
2. Hộp giao việc cho chọn người làm, hạn trả, yêu cầu dành cho outsource, ảnh tham chiếu và template Drive. Có bản xem trước đúng những gì outsource sẽ thấy.
3. Tool kiểm tra task chưa được bên khác giữ hoặc đang render; template phải đúng biến thể, đủ vùng in và có link tải được. Task thiếu dữ liệu nằm lại nội bộ để bổ sung.
4. Outsource mở Design Outsource, chọn task, bấm **Bắt đầu làm**, tải template và đọc yêu cầu/custom.
5. Outsource upload file in vào từng vùng, thêm mockup nếu cần, rồi **Gửi duyệt**. Thiếu thông tin thì **Hỏi nội bộ**; nội bộ tiếp nhận và xử lý với khách nếu cần.
6. Nội bộ xem file, kết quả QA và ảnh tham chiếu trong luồng Duyệt mẫu của Design Tasks. Có thể **Duyệt** hoặc **Trả sửa** kèm lý do và ảnh đánh dấu.
7. Outsource thấy việc bị trả, sửa và gửi phiên bản mới. Khi được duyệt, task xuất hiện ở **Hoàn tất**; quy trình chuyển xưởng tiếp tục ở nội bộ.

Một task gốc có một trạng thái công việc. Chuyển outsource chỉ đổi cách giao và phạm vi truy cập, không tạo task sản xuất thứ hai. Không reset hạn hiện có nếu leader không chủ động đổi; mọi lần giao lại, thu hồi hoặc đổi hạn đều có lịch sử.

## Màn hình của outsource

Thêm mục **Design Studio → Design Outsource**, dự kiến `/design-studio/outsource`. Tài khoản outsource đăng nhập vào thẳng màn này.

Phía trên là các tab **Được giao · Đang làm · Chờ duyệt · Cần sửa · Hoàn tất**. Task đang hỏi thông tin có nhãn **Chờ phản hồi**, không tự chuyển thành đã hoàn thành. Mỗi tab chỉ đếm công việc người đó được phép xem.

Cột trái là hàng đợi, có tìm theo mã outsource, lọc quá hạn và sắp xếp hạn gần nhất. Mỗi dòng gồm thumbnail đã được nội bộ chọn, mã trung lập như `OUT-000128`, trạng thái và hạn trả.

Khung làm việc bên phải có thứ tự:

| Vị trí | Nội dung |
| --- | --- |
| Đầu task | Mã outsource, trạng thái, hạn trả và hành động chính theo trạng thái |
| Dải template | Tên kỹ thuật trung lập, size, khổ px, DPI, hệ màu, số vùng in, **Tải template Drive**, **Mở trên Drive** |
| Yêu cầu | Brief dành riêng cho outsource, text cần in có nút copy, màu/size ảnh hưởng file, font và hướng dẫn nếu có |
| Canvas lớn | File in trên template, vùng in, bleed/safe và artguide |
| Hàng so sánh | Ảnh mẫu cần làm, preview custom và mockup dựng từ file in |
| File và QA | File theo vùng, phiên bản, kết quả kiểm tra; upload file in tại canvas, upload mockup tại ô mockup |
| Trao đổi | Tin nhắn giữa outsource và nội bộ, lý do trả sửa, lịch sử thao tác được phép công khai |

Nút chính lần lượt là **Bắt đầu làm**, **Gửi duyệt**, **Sửa và gửi lại**. Sau khi gửi duyệt, bản nộp được khóa; muốn sửa phải rút về khi chưa được duyệt hoặc được giao một lượt mới sau khi nội bộ phân công lại. Không có nút tự duyệt hoặc chuyển xưởng.

## Thông tin được cung cấp

| Outsource được thấy | Chỉ nội bộ được thấy |
| --- | --- |
| Mã outsource độc lập | Task key gốc, mã đơn, orderId, lineId |
| Loại vật phẩm kỹ thuật nếu cần làm file, ví dụ áo hoặc cốc | Tên listing, product ID, SKU gốc và link trang bán |
| Size, màu, vùng in, kích thước, DPI, bleed và safe | Store, domain, project và thông tin doanh thu |
| Ảnh mẫu/preview được chọn cho việc thiết kế | Tên, email, điện thoại, địa chỉ giao hàng của khách |
| Text hoặc ảnh khách yêu cầu in | Thuộc tính đơn thô, ghi chú CS và lịch sử nội bộ |
| Template, font, tài liệu được duyệt để chia sẻ | Thư viện đầy đủ, đường dẫn NAS, thông tin kết nối Drive |
| Brief, phản hồi và file thuộc task được giao | Tên nhà cung cấp, supplier SKU, giá vốn và thông tin chuyển xưởng |

Tên cần in lên thiết kế được giữ dù đó là tên người; tên khách mua hàng không liên quan đến nội dung in thì không chuyển sang. Brief outsource là trường riêng để tránh hiển thị nguyên ghi chú nội bộ.

Ảnh, file và template dùng tên trung lập. Nếu ảnh có watermark/domain hoặc file có metadata nhận diện store, nội bộ cần chuẩn bị bản chia sẻ phù hợp trước khi giao. Việc đổi tên nhãn trên giao diện không xóa nội dung nằm sẵn trong file.

## Template Drive

Mỗi gói template có tên hiển thị trung lập, link mở Drive, link tải Drive, phiên bản và danh sách vùng in/size áp dụng. Ưu tiên template đã resolve đúng cho dòng task; leader có thể chọn gói khác nhưng phải xác nhận thông số tương ứng. Template nhiều file dùng thư mục riêng hoặc gói ZIP có hướng dẫn.

Tái sử dụng `PrintTemplate.templateUrl` khi link và nội dung đã phù hợp để chia sẻ; bổ sung thông tin dành cho outsource khi cần bản chia sẻ riêng. Không suy diễn link tải từ đường dẫn NAS và không bắt outsource tự tìm template theo SKU.

Chốt phiên bản template khi giao và ghi phiên bản đó vào lần nộp. Nếu template thay đổi giữa chừng, hiển thị **Template đã cập nhật**, thông báo cho người làm và yêu cầu xác nhận trước lần gửi tiếp theo. File làm theo bản cũ phải được nội bộ xem xét lại.

Thiếu link, sai quyền hoặc link hỏng thì hiện **Chưa có template tải được** và chuyển về nội bộ bổ sung. Quyền đọc Drive cần được chuẩn bị trước khi giao; link không thể mở mà không đăng nhập phải có hướng dẫn rõ ràng.

Không cấp outsource link thư mục task nội bộ. Cấu trúc hiện có của `task-folder.ts` chứa store, tháng, mã đơn và task key; nếu cần thư mục chia sẻ, dùng thư mục độc lập mang mã outsource. File từ tool được tải qua route có kiểm tra quyền; template Drive được chia sẻ theo phạm vi đã chọn. Thu hồi task khóa truy cập trên tool; link Drive đã được chia sẻ cần được thu hồi quyền riêng nếu muốn ngừng truy cập.

## Quyền và đồng bộ

Đề xuất quyền `design_outsource` cho người làm và `design_outsource_manage` cho người giao/duyệt. Tài khoản outsource dùng bộ quyền giới hạn riêng, không kế thừa các quyền rộng mặc định của SUPPORT. Quyền duyệt outsource luôn thuộc nội bộ, độc lập với setting `designerCanApprove` của Design Tasks.

API outsource có bộ dữ liệu trả về riêng, chỉ chọn những trường được công khai. Không trả nguyên `TaskDetail` rồi ẩn bằng CSS. Mọi route danh sách, chi tiết, upload, download, preview, trao đổi và chuyển trạng thái đều kiểm tra người được giao từ phiên đăng nhập; đổi mã hoặc ID không được mở task người khác.

Tách tin nhắn và lịch sử dành cho outsource khỏi nội dung nội bộ. Không chuyển nguyên `DesignTaskEvent.message`, URL ảnh Shopify/Customall, tên file hoặc lỗi server nếu chúng chứa thông tin đã loại bỏ. Ảnh cần hiển thị qua route được bảo vệ, tránh đưa URL gốc vào HTML hay redirect ra URL nguồn.

Task đang outsource phải được đánh dấu đang có người giữ để designer nội bộ, AUTO và Design Agent không nhận trùng. Nội bộ vẫn theo dõi được trong Design Tasks với nhãn **Outsource** và người phụ trách. Thu hồi hoặc giao lại khóa lần upload/gửi duyệt mới của người cũ ngay tại server; kết quả request đến trễ không được ghi vào lần giao mới.

Mã outsource là duy nhất và ổn định, ánh xạ về task gốc ở server. Lần giao lại có mã lần giao riêng để phân biệt file và lịch sử, tránh lẫn bản nộp. Chỉ được chuyển các trạng thái phù hợp của task gốc; việc thu hồi không tự approve, không tự chuyển xưởng.

## Hướng triển khai

Các phần có thể dùng lại: canvas template, vùng upload, phiên bản file, kiểm tra kích thước, QA và guard chuyển trạng thái hiện có. Tách giao diện và dữ liệu outsource khỏi các component đang nhận cả thông tin order/store.

Các điểm cần bổ sung: quyền và trang đích trong `roles.ts`; menu trong `Sidebar.tsx`; API `/api/design-studio/outsource` có rule riêng đặt trước rule rộng của Design Studio trong `api-access.ts`; kiểm tra quyền ở các upload/file route; lưu mã outsource, lần giao, người làm, brief và snapshot template; bộ dữ liệu công khai cho danh sách và workspace.

Quan hệ với thư viện thống nhất phải theo spec `2026-11-21-unified-library-design.md`. Thiết kế outsource không mở rộng thêm hệ thư viện legacy hoặc tự ghi bản nộp chưa được duyệt thành artwork có thể tái sử dụng.

## Điều kiện nghiệm thu

- Leader giao và thu hồi task từ Design Tasks; outsource chỉ thấy đúng phạm vi được chọn.
- Không có tên sản phẩm/store hoặc dữ liệu nội bộ trong response JSON, DOM, URL, tên tải file, preview hay lịch sử outsource.
- Link template mở và tải được với tài khoản thực tế của outsource; đúng size, đúng vùng in và đúng phiên bản được giao.
- Người làm thực hiện được bắt đầu, hỏi nội bộ, upload, gửi duyệt, nhận trả sửa và nộp lại; không tự duyệt hoặc chuyển xưởng.
- Bản nộp thiếu vùng in bị chặn; template đổi có cảnh báo; nội bộ duyệt được bản cuối trong task gốc.
- Hai tài khoản outsource không đọc hoặc sửa được task/file của nhau qua API trực tiếp; request đến sau thu hồi/giao lại bị từ chối.
- AUTO, Design Agent và designer nội bộ không nhận trùng task đang outsource; sync không làm mất trạng thái giao việc.

## Sử dụng bản triển khai local

1. Khi đưa bản code vào môi trường chạy, áp dụng migration `20261124011401_design_outsource` bằng quy trình triển khai của dự án và generate Prisma Client. Việc kiểm thử dùng database riêng, không tự đổi database runtime.
2. Trong Setup → Users & Roles, tạo người dùng với vai trò **Design Outsource** rồi đặt mật khẩu. Server cố định vai trò này chỉ có quyền `design_outsource` và chặn các API nội bộ kể cả khi session có quyền rộng hơn.
3. Nội bộ mở task trong Design Tasks, mở **Chuyển outsource**, chọn người làm, brief, link Drive và các trường custom được phép chia sẻ. Size và màu kỹ thuật được giữ lại; các option khác không được chuyển nguyên sang.
4. Kiểm tra phần xem trước và xác nhận ảnh/template chia sẻ phù hợp trước khi giao. Link Drive phải mở và tải được với người nhận; tool không tự thay quyền chia sẻ trên Drive.
5. Người làm đăng nhập vào `/design-studio/outsource`. Nội bộ duyệt hoặc trả sửa ở task gốc; task trả sửa về bảng chung ở trạng thái REJECTED, chưa giao. Lượt outsource cũ đóng ngay. Quản lý chọn người nhận và brief được phép chia sẻ để giao lại. Ghi chú nội bộ vẫn ở task gốc.
6. Thu hồi khóa truy cập task và file trên tool. Thu hồi task đã duyệt giữ nguyên trạng thái DONE và file đã giao xưởng. Muốn ngừng truy cập template Drive đã chia sẻ, xử lý quyền Drive riêng.

Mã nguồn chính: `src/lib/design-outsource.ts`, các route `/api/design-studio/outsource`, trang `/design-studio/outsource` và `OutsourceTaskPanel`. Thông tin giao việc và trao đổi lưu trong `DesignOutsource` / `DesignOutsourceMessage`; file giữ id lần giao, revision và phiên bản gói template. Gói mới có phiên bản mới ngay cả khi chỉ thay link Drive.

Bản đầu giao từng task trong workspace; thao tác chọn nhiều task và giao hàng loạt chưa có giao diện. Kiểm tra tự động trong màn outsource gồm đủ vùng in, phiên bản template và kích thước file; quyết định duyệt vẫn do nội bộ thực hiện.
