# Kết nối thêm một store Shopify

Danh sách việc cần làm khi đưa một store mới vào tool. Chỉ Super Admin làm được các bước ở trang Setup.

## 1. Trước khi kết nối: đặt tiền tố đơn trong Shopify

- Tool nhận ra đơn thuộc store nào nhờ tiền tố trong tên đơn. Tên đơn phải có dạng `<CHỮ><số>`, chữ đứng sát số, không có dấu gạch hay khoảng trắng ở giữa. Ví dụ `REMI1010` là đúng; `REMI-1010` và `1001` là sai.
- Đặt tiền tố trong Shopify Admin → Settings → General → Order ID (ô Prefix).
- Mỗi store phải có tiền tố riêng. Tool từ chối một tiền tố mà store khác đang dùng, kể cả store đã tắt.
- Nếu store chưa có đơn nào, tool vẫn kết nối được nhưng chưa biết tiền tố, nên chưa sync đơn. Khi store có đơn đầu tiên, bấm "Kết nối lại".

## 2. Thêm store

Vào Setup › "Các store đang kết nối" › bấm "Thêm store". Điền Shop domain (dạng `ten-shop.myshopify.com`), rồi chọn một trong ba cách kết nối:

1. **Client ID và Client Secret** của app. Tool tự lấy token và tự lấy token mới trước khi hết hạn. Đây là cách nên dùng.
2. **OAuth**: nếu Shopify không cho app tự lấy token cho shop này, tool tự chuyển sang trang cấp quyền của Shopify. Bấm đồng ý ở trang đó là xong.
3. **Dán access token**, cho store còn dùng app kiểu cũ.

Cùng form đó:

- **Project**: chọn một project chưa gắn store, hoặc để "Tạo project mới" và điền tên.
- **Ngày bắt đầu payout**: tool chỉ lấy payout từ ngày này trở đi.
- **Link trang tracking của khách**: xem mục 3.

Sau khi kết nối, tool báo múi giờ, tiền tố đơn và quyền `read_all_orders`:

- `read_all_orders: có`: tool đọc được mọi đơn cũ.
- `read_all_orders: chưa có`: Shopify chỉ cho đọc đơn trong 60 ngày gần nhất, đơn cũ hơn không về tool. Muốn đọc đơn cũ, thêm quyền `read_all_orders` cho app trong Shopify rồi bấm "Kết nối lại".
- "Quyền của app chưa kiểm tra": bấm "Kết nối lại" để tool đọc lại quyền.

## 3. Link trang tracking

Email báo giao hàng gửi khách link = link trang tracking + số tracking nối ngay phía sau. Vì vậy link phải kết thúc bằng một trong hai dấu:

- `=`, ví dụ `https://ten-shop.com/apps/trackingorder?nums=`
- `/`, ví dụ `https://ten-shop.com/track/`

Link phải là `https`. Tool từ chối link không đúng dạng.

Dưới ô nhập có dòng "Khách sẽ nhận link: …1Z999TEST". Đọc dòng này trước khi lưu: đó chính là link khách sẽ bấm, với một số tracking giả. Nếu số tracking dính liền vào chữ (ví dụ `…/track1Z999TEST`) thì link sai.

Để trống ô này thì email giao hàng không kèm link. Sửa link sau này ở dòng ngay dưới store trong bảng, rồi bấm "Lưu cài đặt".

## 4. Khoá nhà cung cấp của store

Ở dòng của store, bấm "Khoá nhà cung cấp".

**PGprints**: mỗi store có tài khoản PGprints riêng. Tool không bao giờ dùng khoá của store khác.

- Điền Store ID và Secret key của tài khoản PGprints của store, Ship class mặc định nếu có.
- Chép địa chỉ ở dòng "Webhook tracking" (nút "Chép") và đăng ký địa chỉ đó trong tài khoản PGprints của store, để tracking tự về tool.
- Tick "Bật gửi đơn sang PGprints" khi đã sẵn sàng gửi đơn. Chỉ bật được khi có đủ Store ID và Secret key.
- Store đầu tiên (Litzzy) dùng khoá chung, sửa ở trang cài đặt xưởng Pgprints.

**Merchize**: điền cả URL API và token, hoặc không điền gì.

- Không điền gì: store gửi đơn bằng tài khoản Merchize của server.
- Chỉ có một trong hai: store không gửi được Merchize cho tới khi điền đủ.

**ParcelPanel**: điền API key của store. Không có key thì lượt sync tracking ParcelPanel bỏ qua store này. Litzzy dùng khoá chung, sửa ở trang Tracking.

Bấm "Lưu khoá". Tool không bao giờ hiện lại khoá đầy đủ: Super Admin thấy khoá đã che bớt, người khác chỉ thấy đã có hay chưa.

## 5. Xưởng dùng chung

Các xưởng sau dùng chung cho mọi store, không cần cài thêm gì:

- **Sheet Jomall và Mango**: một sheet cho mọi store đang bật. Mỗi dòng mang tên đơn có tiền tố, nhờ đó tracking đọc về đúng store. Đơn có tên không mang tiền tố của store mình thì không được ghi vào sheet.
- **Bondre** và **Printway**: một tài khoản chung.
- **Thư viện file in** cũng dùng chung: cùng SKU thì dùng cùng file in, dù đơn của store nào.

## 6. Thư viện file in trên máy văn phòng

Script `tools/library/phase1.py` chỉ bỏ những tiền tố nó biết khỏi tên file (mặc định `LIT` và `REMI`). Khi thêm store có tiền tố mới, trên máy văn phòng đặt biến môi trường `LIBRARY_ORDER_PREFIXES` với đủ mọi tiền tố, cách nhau bằng dấu phẩy, ví dụ `LIT,REMI,ABC`. Biến này thay hẳn danh sách mặc định, nên phải ghi cả `LIT` và `REMI`.

## 7. Giao store cho seller

Vào Setup › Users, mở user có vai trò Seller, tick store ở phần "Store được xem" rồi lưu. Seller chỉ thấy đơn và số liệu của store được giao. Chỉ giao được store đang bật.

## 8. Đơn đầu tiên và mapping

- Đồng bộ đơn: bấm "Sync Now" ở trang All Orders (`/orders`), hoặc chờ lượt đồng bộ tự động. Xem lỗi (nếu có) ở cột "Lỗi sync gần nhất" trong bảng store.
- Dòng hàng chưa có xưởng nằm ở Product Mapping › tab "Manual Mapping" › "Pending". Dòng không có SKU cũng hiện ở đây: chọn sản phẩm của xưởng cho từng variant rồi lưu. Mapping đã lưu dùng cho mọi đơn sau có cùng variant.

## 9. Tắt store hoặc ngắt kết nối

- **Tắt store** (công tắc ở cột Thao tác): mọi việc chạy với Shopify (đồng bộ tự động, nút Sync Now, Auto Fulfilled) bỏ qua store này cho tới khi bật lại, nhưng đơn đã có của store vẫn hiện trong danh sách đơn và báo cáo. Đơn của store không được ghi vào sheet xưởng, và Setup › Users không cho giao store này cho seller mới. Token, tiền tố, project và cài đặt vẫn giữ nguyên; bật lại là chạy tiếp.
- **Ngắt kết nối**: tool xoá thông tin kết nối Shopify của store, mọi lượt sync của store dừng. Store, tiền tố, project và cài đặt vẫn giữ. Muốn dùng lại, bấm "Kết nối lại" và nhập thông tin kết nối mới.
