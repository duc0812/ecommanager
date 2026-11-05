# Quản lý đa store + đưa Reminiso vào Ecom Manager

Ngày 2026-11-05. Trạng thái: chờ owner duyệt. Code gốc để làm: `origin/main` (7a440f6, đúng bản prod đang chạy). `main` local đang chậm 93 commit, đừng đọc code ở đó.

Mọi quyết định ghi là của **owner** hoặc **tôi chọn**. Phần tôi chọn owner có thể đổi khi duyệt.

## 1. Vì sao làm

Tool hiện chỉ quản lý một store (Litzzy). Owner muốn quản lý nhiều store: có màn gộp, có màn chọn từng store, và seller chỉ thấy store của mình.

Lo ngại chính của owner là **luồng dữ liệu lẫn nhau gây lỗi gọi API**. Lo ngại này đúng: token Shopify chỉ có một bản dùng chung, nên nối store thứ hai theo cách hiện tại sẽ ghi đè Litzzy và mọi lịch đồng bộ âm thầm chuyển sang store mới, không báo lỗi.

Store đầu tiên cần đưa vào là **Reminiso** (reminiso.com, `d1ba2a-75.myshopify.com`).

## 2. Mục tiêu

- Mỗi store có kết nối riêng. Mọi lệnh gọi Shopify đều nói rõ gọi cho store nào.
- Store này lỗi không làm store khác dừng hoặc sai.
- Reminiso chạy đầy đủ trong tool: đơn, payout, mapping, design, xưởng, cashflow.
- Admin xem gộp hoặc lọc theo store. Seller chỉ thấy store được giao.

## 3. Không làm

- Không đụng tool Drop (`drop.thecrafthousellc.com`). Kiểm tra ngày 05/11: DB của nó không có store, thông tin kết nối hay đơn nào của Reminiso, nên không có gì để chuyển hay gỡ.
- Không đổi các tool clone, theme Reminiso, bot Telegram báo đơn của Reminiso.
- Không tách DB theo store (mục 6).
- Không khôi phục Trello cho store mới. Trello đã tắt từ 16/10.
- Không lấy đơn Reminiso cũ hơn cửa sổ 60 ngày, trừ khi owner cấp `read_all_orders` sau này.

## 4. Thất bại dù vẫn "chạy được"

- Token của store này bị ghi đè hoặc bị dùng cho store khác.
- Đơn, payout hoặc ticket gắn nhầm store.
- Seller xem được dữ liệu store khác, kể cả khi gọi thẳng API.
- Số liệu Litzzy trên Overview, cashflow, P&L bị cộng lẫn Reminiso mà người xem không biết.
- Litzzy thay đổi hành vi hoặc gián đoạn do chuyển đổi.
- Một đơn bị gửi xưởng hai lần.
- VPS yếu bị quá tải vì sync nhiều store cùng lúc.

## 5. Hiện trạng đã kiểm tra

**Dữ liệu:** đã có `ShopifyStore`; `Order`, `Payout`, `BankAccount`, `ProductProfile`, `ArtworkEntry`, `ProductLegacyType` có `storeId`. Store gắn 1-1 với `Project`. Meta đi theo Project. `DesignTask`, `OrderLine`, `DesignArtwork`, `Shipment` suy ra store qua `Order`.

**Kết nối:** `src/lib/token-store.ts` giữ một bộ `shopify.connection.*` và `shopify.app.*` trong `AppSetting`, cache trong biến global. 19 file gọi `getShopifyConnection()`:
- API: `auth/status`, `design-studio/orders/[id]/refresh`, `fulfillment/auto-fulfill/run`, `fulfillment/normalize`, `fulfillment/orders/[id]/recheck`, `fulfillment/supplier-performance/backfill`, `fulfillment/task-fix/fix`, `fulfillment/tracking/parcelpanel-sync`, `fulfillment/tracking/sync`, `shopify/orders/sync`, `shopify/payouts`, `shopify/payouts/[id]`, `trello/backfill-custom-info`.
- Lib: `design-studio.ts`, `fulfillment/auto-fulfill-scheduler.ts`, `order-normalize-scheduler.ts`, `shopify-payouts-sync.ts`, `tracking/parcelpanel-scheduler.ts`, `tracking/scheduler.ts`.

**Lịch chạy:** khởi động trong `src/instrumentation.ts`. Liên quan store: auto-sync, tracking, order normalize, ParcelPanel, auto-fulfill, cashflow snapshot, daily sync, design-task sync, CS. `auto-sync` gọi đơn qua HTTP tới `/api/shopify/orders/sync`, cần xác minh cách đó còn qua được middleware khi không có cookie.

**Truy vấn:** khoảng 50 file đọc đơn/payout/task/shipment/ticket, 12 trong số đó là route API đọc trực tiếp. Nhiều file không lọc store. `api/overview` và `api/shopify/db-payouts` dùng `shopifyStore.findFirst`.

**Phân quyền:** chỉ theo tính năng (`role` + `permissions`). `AppUser` không gắn với store hay project, nên seller đang thấy mọi dữ liệu của tính năng được cấp.

**Cấu hình chỉ có một bản:** `pgprints.storeId/secretKey/defaultShipClass/pushEnabled`, `MERCHIZE_API_URL/TOKEN` (biến môi trường server), `parcelpanel_api_key`, `cs.*`, `auto_fulfill_sheets` (mỗi sheet đã có `storeBase`), `SHOPIFY_PAYOUT_START_DATE`.

**Gắn cứng Litzzy:** `cs/order-context.ts` (regex `LIT`, link tracking), `cs/agent-prompt.ts`, `cs/actions.ts` (`support@litzzy.com`), `fulfillment/auto-fulfill-sheets.ts` (`DEFAULT_STORE_BASE`), `tools/library/phase1.py` (`LINE_PREFIX_RE`).

**Reminiso (đọc API ngày 05/11):**
- Project có sẵn ở `D:\POD GMC STORE 3`; file `env` chứa Client ID, Secret của app Dev Dashboard.
- Client credentials chạy được, token hết hạn sau 24 giờ. Múi giờ America/Denver, USD, Shopify Payments đang bật.
- 135 đơn đọc được, #REMI1010 (06/10) đến #REMI1144 (04/11), đều UNFULFILLED. Chưa rõ đơn đã được xử lý ở đâu.
- Chưa có `read_all_orders`. Đơn cũ nhất đọc được sẽ ra khỏi cửa sổ 60 ngày từ khoảng 05/12. **Phải sync lần đầu trước ngày này.**
- 186 dòng hàng, 46 dòng không có SKU. Thuộc tính gồm `Custom Name` (69), `_design` (32), `_tb_design` (8), `Enter Name`, `Skin Color`… Payout đọc được từ 09/2024.

**Shopify:** từ 01/01/2026 không tạo mới được app kiểu cũ trong admin; app cũ vẫn chạy. App mới tạo ở Dev Dashboard, có Client ID + Secret. Client credentials chỉ dùng được khi app và store cùng tổ chức, token 24 giờ. OAuth không có giới hạn này. Thời hạn token OAuth cần đối chiếu tài liệu chính thức khi làm.

## 6. Quyết định

### Của owner

1. **Dùng chung** giữa các store: xưởng, đội design.
2. **Tách riêng**: hộp thư CS, sheet fulfill (nhân sự sẽ tách), API PGprints.
3. **Quyền xem:**
   - Seller: chỉ store được giao.
   - Admin, Super Admin: tất cả, có gộp và lọc.
   - Design: mọi store trong một hàng chờ, có nhãn store.
   - Support làm CS: chỉ hộp thư của store được giao.
   - Support làm tracking: mọi store.
4. **Mỗi store một app riêng**, với thông tin kết nối riêng.
5. **Reminiso chuyển hẳn sang tool này.**
6. **Giữ lịch sử đơn trong DB của mình**, không phụ thuộc cửa sổ 60 ngày của API.
7. **Sync toàn bộ đơn Reminiso về và mapping như đã làm với Litzzy**, không đặt mốc cắt.
8. **Đơn Reminiso do cùng một người fulfill.** Tôi hiểu là người này biết đơn nào đã gửi xưởng và tự đối chiếu, nên tool không cần trạng thái "đã xử lý ở nơi khác".
9. **Quảng cáo Reminiso chạy trên tài khoản Meta khác** với Remi03/04/05/08/10. Owner tự gắn tài khoản vào Project Reminiso. Không phải chia chi phí theo campaign.
10. **Đơn gửi Jomall dùng chung sheet** cho mọi store.

### Tôi chọn

**a. Một DB chung, phân biệt bằng `storeId`.** Owner nói "database riêng để lưu trữ", tôi hiểu là giữ lịch sử trong DB của mình và đã nêu rõ cách hiểu này, owner không phản đối. Tách file theo store sẽ làm khó màn gộp và hàng chờ design chung, migrate nhiều file dễ lệch, và vẫn không thay được việc chặn quyền ở server.

**b. Kết nối.** "Thêm store" nhận tên shop, Client ID, Secret:
- Thử client credentials trước và tự lấy token mới trước khi hết hạn.
- Không được thì chạy OAuth (tool đã có luồng này, phải đổi để nhận app theo từng store).
- Có ô dán token cho store còn app kiểu cũ.
- Litzzy giữ nguyên token đang chạy, không phải kết nối lại.
- Thông tin bí mật chỉ ở DB, GET chỉ trả dạng che, chỉ Super Admin được đổi.

**c. Khoá chạy và thứ tự.** Lịch chạy lần lượt từng store, mỗi store có khoá riêng, lỗi được ghi theo store và không dừng store sau. Không chạy song song giữa các store vì VPS yếu.

**d. Quyền xem theo store.** Lọc ở server qua một hàm dùng chung, theo hai quy tắc:
- **Role SELLER:** luôn bị giới hạn theo danh sách store được giao, ở **mọi** tính năng, kể cả khi được cấp `design_tasks` hay `fulfillment_tracking`.
- **Tính năng `cs`:** với mọi role trừ Admin và Super Admin, chỉ thấy ticket của store được giao.
- **Còn lại:** Admin, Super Admin và Support thấy mọi store ở các tính năng vận hành (đơn, export, Need To Fix, Design Studio, Design Library, tracking, supplier, mapping), vì xưởng và đội làm đơn dùng chung.

Khi nâng cấp, seller đang có mặc định chỉ có Litzzy; Support không đổi gì cho tới khi có CS theo store. Quy tắc này chỉ dùng một danh sách store cho mỗi user.

**e. Giao diện.** Bộ chọn "Tất cả store / từng store" ở các màn số liệu và đơn. Cột hoặc nhãn store ở danh sách có trộn nhiều store. Seller chỉ có một store thì không thấy bộ chọn.

**f. Số liệu cashflow, P&L** tính theo từng store như hiện tại theo Project; màn gộp ghi rõ là tổng của những store nào. Múi giờ theo từng store.

**g. Merchize.** File `env` của Reminiso có khoá Merchize riêng. Thêm cấu hình theo store, không có thì dùng khoá server hiện tại.

**h. Đơn đang ở trạng thái mở khi sync lần đầu.** Theo quyết định 7 và 8, 135 đơn vào quy trình bình thường, kể cả task design. Tool không tự gửi xưởng và không chặn thêm; người fulfill đối chiếu đơn nào đã gửi trước khi gửi đợt đầu (mục 8).

**l. Sheet Jomall chung.** `channel.storeShop` đang chỉ nhận một store và trả về BLOCKED với store khác (`repos/sheet-push.ts`); đổi để kênh nhận mọi store đang bật. Mã dòng trong sheet đã mang số đơn (`#REMI1010_1`), nên phân biệt được store. Đọc tracking về (Auto Fulfilled) phải tìm store từ chính đơn đó để lấy đúng token và link tracking, không dùng `storeBase` của sheet, vì một sheet giờ có thể chứa đơn của nhiều store.

**i. Thứ tự làm** (mục 7). Reminiso chỉ vào prod sau khi đã có lọc quyền và bộ chọn store, để không lẫn số Litzzy.

**j. Payout Reminiso tính từ 06/10/2026**, ngày của đơn cũ nhất đọc được, và đó cũng là `startDate` của Project. Payout từ 2024 không lấy về: chúng không có đơn, chi phí quảng cáo hay giá xưởng đi kèm nên sẽ làm lợi nhuận gộp sai. Vì vậy ngày bắt đầu payout theo store phải có từ giai đoạn 4, không đợi giai đoạn 5. Nghiệm thu payout so với Shopify tính từ ngày này.

**k. File in không tự dùng chéo giữa các store.** "Dùng chung đội design" là một đội, một hàng chờ, không có nghĩa dùng chung file. `SkuSupplierDesign` đang khoá theo SKU + supplier và khớp được theo tiền tố SKU, nên phải có thêm store (dữ liệu cũ là Litzzy). Dòng Reminiso không tự nhận file in Litzzy và lưu thiết kế Reminiso không ghi đè file Litzzy. Print index của `process-new-orders` cũng chỉ tái sử dụng trong cùng store. Muốn dùng lại file của store khác thì designer chọn tay. Lý do: in nhầm file tốn tiền thật, còn làm lại một lần thì không.

## 7. Các giai đoạn

Mỗi giai đoạn deploy riêng được, và Litzzy phải chạy như cũ sau mỗi giai đoạn.

1. **Kết nối theo store.** Lưu thông tin kết nối theo `ShopifyStore`, chuyển Litzzy sang, thay `getShopifyConnection()` ở cả 19 file. Không đổi hành vi.
2. **Lịch chạy theo store.** Các lịch trong mục 5 lặp theo từng store đang bật, cô lập lỗi.
3. **Quyền và bộ chọn.** Danh sách store của user, lọc server cho mọi route đọc dữ liệu theo store, bộ chọn và nhãn store, bỏ `findFirst`.
4. **Thêm store + Reminiso.** Form "Thêm store" có ngày bắt đầu payout, tạo Project "Reminiso", sync đủ 135 đơn và payout từ 06/10. Thư viện file in tách theo store. Kênh sheet Jomall và Auto Fulfilled nhận đơn nhiều store (mục 6.l). **Hạn: trước 05/12.** Mapping theo cách làm với Litzzy; các dòng không có SKU phải map được theo variant hoặc product.
5. **Cấu hình theo store.** PGprints, Merchize, ParcelPanel, sheet fulfill, bỏ các chỗ gắn cứng Litzzy không thuộc CS.
6. **CS theo store.** `CsTicket` có `storeId`, hộp thư Freshdesk, giọng trả lời và chữ ký riêng, tìm đơn trong đúng store, Support chỉ thấy store được giao. Chỉ làm khi owner có thông tin hộp thư của Reminiso.

## 8. Việc owner cần làm

- Tách sheet tracking đọc về theo store nếu vẫn cần (nhân sự). Sheet đơn gửi Jomall dùng chung.
- Cấp API PGprints riêng của Reminiso.
- Giao store cho từng seller trên trang Users & Roles.
- Người fulfill đối chiếu 135 đơn trước đợt gửi xưởng đầu, để không in hai lần.
- Gắn tài khoản Meta của Reminiso vào Project trên trang hiện có.
- Khi tới giai đoạn 6: cung cấp hộp thư Freshdesk của Reminiso.

## 9. Ràng buộc kỹ thuật

- Làm trong worktree riêng cắt từ `origin/main`; checkout chính được nhiều phiên dùng chung.
- Quy tắc trong `CLAUDE.md`: route mới phải có rule trong `API_ACCESS_RULES`; route đổi secret phải `requireSuperadmin`; test chạy trên `test.db`, không dùng `dev.db`.
- Trên máy này `prisma migrate dev` có thể không tạo gì mà vẫn báo thành công: kiểm tra `prisma/migrations`, dựng folder từ `migrate diff` khi cần. Bump `SCHEMA_VERSION` (đang `v81`). Migrate trên prod cần `pm2 stop`.
- Kiểm tra số liệu bằng bản sao prod mới, không dùng `dev.db`. Nghiệm thu migration trên bản sao đó.
- Prod là SQLite (khoảng 134 MB) trên VPS yếu, app bị giới hạn RAM 1400 MB. Ghi từ từ, theo dõi RAM khi sync lần đầu.
- Script và công cụ chạy trên PC (`scripts/process-new-orders.mjs`, `push-*`, worker) đang ngầm hiểu một store. Phải rà khi tới giai đoạn 4: ô NAS đã tách theo tên Project trong `repos/artwork-nas.ts`.

## 10. Nghiệm thu

- Đổi hoặc làm hỏng token Reminiso: Litzzy vẫn sync bình thường, tool báo lỗi đúng store.
- Sau 48 giờ, Reminiso tự lấy token mới mà không cần ai can thiệp.
- Số đơn và payout Reminiso trong tool khớp Shopify; tổng Litzzy không đổi so với trước khi nối.
- Seller chỉ có Litzzy gọi thẳng API đơn, payout của Reminiso: bị từ chối. Danh sách không có đơn Reminiso.
- Design Studio hiện đơn cả hai store, có nhãn.
- Đơn Reminiso đẩy được vào sheet Jomall. Tracking đọc về fulfill đúng store, kể cả khi sheet có dòng của cả hai store.
- Toàn bộ test hiện có vẫn pass. Có test mới cho: chọn token theo store, cô lập lỗi lịch chạy, lọc quyền theo store.

## 11. Để người làm tự quyết

Cấu trúc bảng và tên trường, tên hàm dùng chung, cách mã hoá secret nếu cần, cách bố trí giao diện theo mẫu sẵn trong `CLAUDE.md`, cách chia commit trong từng giai đoạn. Cách tool đọc `_tb_design` cho Design Studio: các dòng đó tạm làm tay nếu chưa đọc được, không chặn giai đoạn 4.
