# Chỉnh thông tin sản xuất theo dòng hàng

Ngày 10/11/2026. Trường hợp đầu tiên: LIT6061_1, Shopify ghi S nhưng khách xác nhận Large và tên Marcie; artwork WZIP-L đã có đủ 12 mảnh.

Admin mở task ở tab làm việc hoặc duyệt, chọn **Chỉnh thông tin sản xuất**, chọn size/mã xưởng cùng sản phẩm và màu, nhập tên custom nếu cần và lý do. API: `GET|PATCH /api/design-studio/tasks/{key}/production`. PATCH cần `supplierProductId`, `reason`, `revision` lấy từ GET; `customName` là tùy chọn, chuỗi rỗng có nghĩa không tên.

Mỗi dòng có `OrderLine.productionOverrideJson` gồm dữ liệu sản xuất, bản gốc lúc chỉnh và lịch sử người sửa/lý do/thời điểm. Các trường đang dùng của dòng được cập nhật cùng transaction để task, template, giá vốn và các kênh xuất cùng đọc một bộ dữ liệu. Mapping toàn sản phẩm không đổi. Đồng bộ Shopify áp dụng dữ liệu đã chỉnh trước khi phân loại/resolve, và lưu lại JSON khi tạo lại OrderLine. Refresh thuộc tính và Customall giữ tên đã sửa. Mapping/cost refresh ưu tiên mã xưởng đã chọn.

Chỉnh sản xuất xoá link design cũ trên dòng và đưa đơn về chờ design; file in vẫn giữ nguyên để kiểm tra theo yêu cầu mới. Task chưa tự duyệt. Dòng đã DONE/CANCELLED, đơn đóng, đã xuất/giao xưởng, có sheet write đang gửi hoặc render đang chạy bị từ chối. Sửa bằng phiên bản cũ trả 409.

Bảng xác nhận ghi sheet hiển thị mã xưởng, mã ghi sheet, size, màu và tên in thực tế. Ghi sheet vẫn qua cổng duyệt/handoff hiện hành; chỉnh thông tin không gửi sheet.

Migration: `20261109223758_line_production_override` thêm một cột nullable, không sửa dữ liệu cũ.

Kiểm thử: bộ integration riêng kiểm tra lưu/audit/template, giữ dữ liệu qua Shopify sync và refresh thuộc tính, mapping/cost, chặn quyền và dữ liệu stale, chặn dòng đã gửi và giữ nguyên sibling/mapping chung. Kiểm thử sheet ghi L/Marcie vào đúng cột của API Google giả lập.

Triển khai cần áp dụng migration bằng Prisma, generate client, build và nạp bản mới của ứng dụng; không thay/copy database hoặc environment. Sau đó dùng API mới để chỉnh riêng LIT6061_1 sang supplier product `cmub8klwr0u04q3xagyccts7s` (WZIP-L), customName `Marcie`; xác minh task trả template `a90c876f-e719-4ad4-9017-343ce1115bbf` và 12 file đúng khổ L. Giữ REVIEW, chưa handoff.
