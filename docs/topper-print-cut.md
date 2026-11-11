# Gỗ 3D VN — Topper: hai ô file in / file cắt

Thay đổi này chưa triển khai lên production.

- Xưởng được người dùng xác nhận là **Gỗ 3D VN**, mã xưởng `3`; không tự áp preset này cho Topper của Bondre hoặc xưởng khác.
- Khi chưa có template được gán, các product type `Topper`, `Tree Topper`, `Acrylic Tree Topper` của Gỗ 3D VN tự nhận preset hai ô `Print` và `Cut`. Task chưa map xưởng vẫn có hai ô để chuẩn bị artwork; preset này không tự đổi mapping hoặc giá vốn của dòng hàng. Không nhận diện bằng từ khóa trong tên sản phẩm.
- Canvas nhận một file mỗi ô, hiển thị phiên bản và kích thước thực tế; có nút chồng ảnh và chỉnh độ mờ file cắt khi hai file cùng khổ.
- Không yêu cầu khổ chuẩn, DPI, bleed hoặc vùng an toàn. Hai file cần có kích thước pixel đọc được và giống hệt nhau theo cả hai chiều; không tự xoay hoặc co giãn file.
- QA, gửi duyệt, duyệt xong, gửi API và xuất CSV/sheet đều đối chiếu phiên bản hiện tại của hai file. Mockup, file đã xóa và phiên bản cũ không đủ điều kiện thay thế.
- Kiểm tra cùng khổ không chứng minh đường viền trùng nhau. Người duyệt cần soi đường cắt, vị trí và hướng trên ảnh chồng.
- Các template khổ cố định giữ quy tắc hiện tại. Template được gán rõ ràng vẫn được ưu tiên hơn preset; có thể bật chế độ “Hai ô in/cắt, khổ tự do” tại trang sửa template.

Không thay đổi schema, database production, mapping xưởng, trạng thái đơn hoặc file artwork. Preset dùng hình học nội bộ chỉ để bố trí hai ô, không dùng hình học đó làm khổ in yêu cầu. Metadata `sizing: MATCH_PRINT_CUT` được lưu trong JSON `areas` của template tạo qua API.

Sau khi được phép triển khai, áp dụng bản vá này lên checkout production hiện tại, giữ các thay đổi đang có ở đó, build và kiểm tra một task Topper qua API: `slots` phải là `["Print", "Cut"]`, Canvas có hai ô và QA không báo khổ chuẩn/DPI. Không duyệt hay gửi xưởng trong bước kiểm tra.
