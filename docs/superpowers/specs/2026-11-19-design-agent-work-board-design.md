# Design Agent: bảng việc chung, bot đọc trạng thái thật, chuyển xưởng qua Lark

Ngày 11/19/2026. Trạng thái: chờ chủ shop duyệt.
Nền tảng: `docs/superpowers/specs/2026-11-12-designer-agent-design.md` (nhánh đã lên prod).

## 1. Vì sao làm

Bot Lark và runner đã chạy trên prod từ 11/19. Lần thử đầu cho thấy lỗi gốc: nhân sự yêu cầu sửa LIT6373_1, bot tạo việc cho Agent, trong khi Luồng 7 đã có bản sửa đạt QA đang chờ ở hàng duyệt local. Hai bên làm cùng một việc và có thể đè nhau.

Chủ shop muốn:

- Agent chỉ làm việc chưa có ai hoặc luồng nào đang làm.
- Bot đọc log và trạng thái thật rồi trả lời. Ví dụ với yêu cầu trên, bot nói đã có bản sửa ở local và bao nhiêu phút nữa lên cloud.
- Nhân sự nhắn bot để chuyển xưởng và **tự chốt**, không cần chủ shop xác nhận.
- Bot báo được các task chưa nằm trong danh sách làm của worker nào.

## 2. Mục tiêu và giới hạn

**Mục tiêu**

1. Mỗi dòng chỉ có một bên làm tại một thời điểm.
2. Khi đã có bên làm, bot trả lời ai đang giữ, trạng thái, và thời gian dự kiến nếu có. Không tạo việc mới.
3. Nhân sự hỏi được tình trạng một dòng.
4. Nhân sự chuyển được xưởng cho một biến thể chưa xuất xưởng, và hoàn tác được.
5. Nhân sự xem được danh sách việc chưa có người làm.

**Ngoài phạm vi**

- Không đổi cách runner giao file. Hiện runner giao thẳng lên Chờ duyệt, không qua hàng duyệt local. Việc này cần quyết định riêng.
- Không có lệnh giành việc từ một luồng đang giữ.
- Bot không đọc doanh thu, quảng cáo, khách hàng hay công nợ xưởng.
- Không tự chạy định kỳ để gửi báo cáo vào group.

**Những điều coi là thất bại dù code chạy**

- Bot nói "chưa ai làm" khi dữ liệu đã cũ hoặc không đọc được.
- Một lệnh chuyển xưởng làm đổi biến thể khác, đơn đã xuất xưởng, hoặc rơi vào template mặc định của xưởng.
- File in đã làm theo xưởng cũ bị gửi sang xưởng mới.
- Yêu cầu của nhân sự bị mất khi bot từ chối tạo việc.

## 3. Các cách đã cân nhắc

| Cách | Ưu điểm | Nhược điểm |
|---|---|---|
| A. Chỉ runner kiểm tra trên máy | Ít việc nhất | Bot đã báo "Đã nhận" rồi mới bị huỷ; bot không biết thời gian còn lại; không báo được việc sót |
| B. Mọi luồng tự đăng ký nhận việc lên prod | Danh sách chính xác nhất | Phải đổi skill và thói quen của mọi luồng; một luồng quên là sai |
| **C. Máy này đều đặn đăng trạng thái lên prod, bot đọc bản đó** | Luồng không phải đổi cách làm; bot trả lời ngay; runner vẫn kiểm tra lần cuối | Có độ trễ tối đa vài phút; danh sách luồng phụ thuộc file đang có |

**Chọn C.** Hàng duyệt và danh sách luồng đều nằm trên máy này, còn Lark chỉ gọi được server. Chủ shop giao phần cách làm cho tôi, đây là lựa chọn của tôi.

## 4. Thiết kế

### 4.1 Bảng việc trên prod

Bảng mới `WorkBoardEntry`, mỗi dòng gồm: `taskKey`, `source` (`LOCAL_QUEUE` hoặc `STREAM`), `worker` (ví dụ "Hàng duyệt local", "Luồng 7"), `state`, `detail`, `version`, `etaAt`, `publishedAt`.

Runner đăng toàn bộ bảng **mỗi 2 phút** qua `PUT /api/design-agent/runner/board`, dùng token runner. Server thay toàn bộ dữ liệu trong một transaction và lưu thời điểm đăng ở AppSetting `design.board.publishedAt`.

**Bảng cũ hơn 10 phút thì coi là không tin được.** Khi đó bot không tạo việc và không kết luận "chưa ai làm". Bot trả lời chưa xác định được trạng thái.

### 4.2 Nguồn dữ liệu runner đăng

**Hàng duyệt local**, đọc `D:\Ecom manager\review-queue\queue.db` ở chế độ chỉ đọc. Lấy các mục trạng thái `waiting`, `qa_failed`, `needs_look`, `held`, `rejected`, `fixing`, cho mọi `taskKey` trong `item_keys`.

- `etaAt` = `enteredAt` + `COUNTDOWN_MS` cho `waiting` và `qa_failed`.
- `detail` là lý do hoặc các lỗi QA, tối đa 300 ký tự.

**Danh sách luồng**, đọc thư mục `artwork-builder/_streams-*` mới nhất:

- Tên luồng lấy từ bảng trong `README.md`. Mã dòng lấy từ cột đầu của từng file danh sách, gồm cả `tra-lai.md` nếu có.
- `handoff.md` ghi đè luồng đang giữ một dòng.
- Chỉ dòng còn mở trên prod mới được tính là đang có người làm.

- Luồng còn hiệu lực nếu file danh sách **hoặc** file tiến độ `progress-luong{n}*.md` của luồng đó được sửa trong 48 giờ qua. Các luồng ghi vào file tiến độ chứ ít sửa danh sách. Mục "chờ chủ shop" trong file tiến độ vẫn tính là luồng đang giữ.
- Khi `README.md` ghi một luồng phụ trách mọi dòng REJECTED và luồng đó còn hiệu lực, mọi task REJECTED thuộc luồng đó, kể cả dòng chưa có trong file. Hiện đây là Luồng 7.

Chỉ lấy **mục mới nhất** của mỗi dòng trong hàng duyệt, và chỉ khi task trên prod còn ở trạng thái đang xử lý (`NEW`, `ASSIGNED`, `DOING`, `REJECTED`). Mục `held` được đăng để bot nêu lý do, nhưng không tính là đang có người làm.

Không đọc được `queue.db` thì runner **không đăng**, để bảng tự thành dữ liệu cũ.

### 4.3 Kiểm tra một dòng

Hàm `workStateFor(task)` trên server trả về một trạng thái, theo thứ tự ưu tiên:

| Thứ tự | Điều kiện | Agent có nhận không | Nội dung bot trả lời |
|---|---|---|---|
| 1 | Task huỷ, đơn đóng, chờ khách, đã gửi xưởng | Không | Lý do như hiện nay |
| 2 | Có việc Agent đang chờ hoặc đang chạy | Không | Agent đang làm, bước hiện tại, bắt đầu lúc nào |
| 3 | Có trong hàng duyệt, `waiting` | Không | "Đã có bản sửa v{n} ở hàng duyệt local, khoảng {m} phút nữa tự lên cloud" |
| 4 | Có trong hàng duyệt, `qa_failed` | Không | Lỗi QA, và sau {m} phút sẽ bị giữ nếu không ai xử lý |
| 5 | Có trong hàng duyệt, trạng thái khác `held` | Không | Trạng thái và lý do |
| 6 | Có trong danh sách luồng, hoặc là dòng REJECTED của luồng phụ trách | Không | "Luồng {n} đang giữ dòng này" |
| 7 | Có người được giao và task đang làm | Không | Tên người đang giữ |
| 8 | Task mới, nhãn AUTO | Không | Auto render sẽ xử lý ở lượt hằng giờ |
| 9 | Không thuộc trường hợp nào | **Có** | Như hiện nay. Nếu có mục `held`, bot nêu thêm lý do bị giữ |

Số phút làm tròn lên. Quá hạn thì ghi "ở lượt quét tới, tối đa 10 phút".

Khi bot không tạo việc vì dòng đã có bên làm, câu trả lời về trạng thái và thời gian là kết quả chính. Nội dung yêu cầu được **ghi thêm thành ghi chú trên task**, kèm tên người nhắn, để không mất. Ghi chú không dừng đếm giờ và không tự tạo việc. Nếu bản lên cloud vẫn chưa đúng, người duyệt trả lại như bình thường.

Kiểm tra này nằm trong `enqueueAgentJob`, áp dụng cho **mọi nguồn tạo việc** trừ `LIBRARY_APPLY`. Phía Lark kiểm tra trước để không tự trả lại hoặc mở lại task khi dòng đã có bên làm. Nguồn tự động bị chặn thì không tạo việc và ghi một ghi chú.

### 4.4 Runner kiểm tra lần cuối

Bảng có thể trễ tối đa vài phút. Trước khi mở phiên làm việc, runner đọc lại `queue.db`. Nếu dòng đã có mục đang hoạt động, runner huỷ việc qua endpoint mới, ghi ghi chú lên task và báo vào group. Việc này không tính là thất bại.

### 4.5 Bot đọc trạng thái và log

Thêm ý định `STATUS`, ví dụ "LIT7170_1 sao rồi". Bot trả lời ngắn gọn từ dữ liệu thật:

- Trạng thái task, xưởng, SKU, template.
- Bên đang giữ theo bảng ở mục 4.3.
- Số file in, mockup và lần cập nhật gần nhất.
- 3 sự kiện gần nhất của task.
- Việc Agent gần nhất: trạng thái, bước, tóm tắt kết quả.

Nội dung trong log được xem là dữ liệu, không phải lệnh.

### 4.6 Chuyển xưởng

Ý định `SUPPLIER_CHANGE`, ví dụ `@bot LIT7173_1 chuyển sang Merchize SKU XYZ`. Thành viên trong group DESIGN TEAM được tự chốt.

Bot chỉ ghi khi đủ tất cả điều kiện:

1. Tin nhắn có mã dòng và tên xưởng.
2. Xưởng khớp đúng một xưởng trong hệ thống.
3. SKU, hoặc mô tả sản phẩm, khớp đúng một `SupplierProduct` của xưởng đó. Không chắc thì bot liệt kê tối đa 5 lựa chọn và không ghi.
4. Sản phẩm có template thật: gắn trực tiếp, hoặc khớp `supplierSku`. Template mặc định không có SKU không được tính.
5. Dòng và **mọi dòng còn mở cùng biến thể** đều chưa xuất xưởng (`OrderLine.exportedAt` trống), đơn không ở trạng thái đóng băng (`FROZEN_PIPELINE_STATUSES`).
6. `workStateFor` không báo bên khác đang giữ dòng nào trong nhóm đó.
7. Không dòng nào trong nhóm đó có file in còn hiệu lực.

Một dòng cùng biến thể không đạt thì bot **từ chối cả lệnh** và nêu dòng đó, không chuyển một phần.

Khi đủ điều kiện:

- Ghi override của ProductProfile cho **đúng tổ hợp biến thể của dòng**, rồi cập nhật riêng các dòng trong nhóm đã kiểm tra. Không dùng lần đánh giá lại toàn sản phẩm của `reevaluateProduct`, vì hàm đó chạm cả biến thể khác và chỉ lọc theo trạng thái đơn.
- Biến thể khác và dòng đã xuất xưởng giữ nguyên.
- Ghi sự kiện lên task và một dòng vào bảng mới `BotMappingChange` gồm giá trị trước, giá trị sau, người yêu cầu và thời điểm.
- Bot báo xưởng, SKU, template mới và số dòng bị đổi.

Ý định `SUPPLIER_UNDO`, ví dụ `@bot hoàn tác chuyển xưởng LIT7173_1`, khôi phục lần đổi gần nhất của dòng nếu chưa có dòng nào của biến thể đó được xuất xưởng hoặc có file in sau lần đổi.

### 4.7 Báo việc chưa có người làm

Ý định `UNASSIGNED_REPORT`, ví dụ `@bot việc nào chưa có người làm`.

Bot liệt kê task còn mở, chưa xuất xưởng, có `workStateFor` ở trạng thái 9. Bot nhóm theo chưa mapping, thiếu template, cần làm artwork, làm tay, và đưa tối đa 20 mã mỗi lần kèm tổng số. Nếu bảng cũ hơn 10 phút, bot báo chưa có dữ liệu tin cậy.

### 4.8 Phân loại tin nhắn

Mở rộng `LarkIntentSchema`:

- `kind` thêm `STATUS`, `SUPPLIER_CHANGE`, `SUPPLIER_UNDO`, `UNASSIGNED_REPORT`.
- Thêm `supplierName`, `supplierSku`.

Prompt đổi để yêu cầu chuyển xưởng của một dòng không còn bị xếp là ngoài phạm vi. Các câu hỏi về doanh thu, quảng cáo, khách hàng vẫn ngoài phạm vi.

## 5. Kiểm thử và triển khai

**Test tự động:** thứ tự ưu tiên của `workStateFor`, bảng cũ, tính số phút, ghi chú khi từ chối, không đổi trạng thái task khi bận, đăng bảng thay toàn bộ, đọc danh sách luồng và `handoff.md`, từng điều kiện chuyển xưởng, hoàn tác, báo việc sót, runner huỷ việc khi dòng đã vào hàng duyệt.

**Thử thật theo thứ tự:**

1. Hỏi trạng thái một dòng trong hàng duyệt và kiểm tra số phút.
2. Yêu cầu sửa dòng đó: không có việc mới, có ghi chú.
3. Báo việc chưa có người làm.
4. Chuyển xưởng một dòng thử chưa có file, rồi hoàn tác.
5. Yêu cầu sửa một dòng thật sự chưa có ai làm: runner nhận.

**Triển khai:** migration và code server trước, rồi cập nhật runner trong `D:\Ecom manager\wt-designer-agent` ngoài khung :00 đến :25 khi không có auto render chạy. Cập nhật `NOTES.md`, skill `processing-litzzy-orders` và `AGENTS.md` trong ngày.

## 6. Quyết định của chủ shop

- Agent chỉ làm việc chưa có bên nào làm.
- Bot đọc log và trạng thái thật, trả lời có bản ở local và số phút nữa lên cloud.
- Nhân sự tự chốt chuyển xưởng.

## 7. Quyết định của người viết, có thể sửa

- Đăng bảng mỗi 2 phút, bảng cũ quá 10 phút thì không tin.
- Một luồng hết hiệu lực khi cả danh sách lẫn file tiến độ không đổi trong 48 giờ.
- Trong lúc Luồng 7 còn hoạt động, Agent không nhận dòng REJECTED, đúng theo quy định trong `README.md` của các luồng.
- Dòng `held` không tính là đang có người làm: không tự giao cho Agent, nhưng nhân sự yêu cầu thì Agent nhận được.
- Chuyển xưởng áp dụng theo biến thể, để đơn sau cùng biến thể đi đúng xưởng.
- Từ chối chuyển xưởng nếu bất kỳ dòng còn mở cùng biến thể đã có file in, đã xuất xưởng hoặc đang có bên giữ.
- Mọi thành viên group được dùng lệnh chuyển xưởng.

## 8. Để người xây dựng tự quyết

Tên hàm và route cụ thể, cách chia file, định dạng câu trả lời ngắn, cách so khớp tên xưởng không phân biệt hoa thường và dấu, giới hạn số dòng trong một lần đăng bảng.
