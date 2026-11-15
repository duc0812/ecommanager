# Giao file in qua API (Artwork Delivery API)

Ngày: 2026-11-15. Trạng thái: chờ chủ shop duyệt. Giai đoạn 1 của chương trình "xưởng local" (mục 9). Đã qua một lượt soát độc lập đối chiếu với code `origin/main` (044ef7e).

## 1. Vì sao làm

Chủ shop muốn tăng năng lực xử lý đơn: thêm PC thứ hai, nhiều luồng agent chạy song song. Chỗ nghẽn lớn nhất đo được không nằm ở khâu làm file mà ở khâu **đưa file lên prod**:

- Mỗi lượt đẩy hiện nay: PC local SSH vào VPS bằng quyền root, `VACUUM INTO` cả DB, `scp` bản sao về, chạy thử các câu SQL trên bản sao, rồi ghi SQL thẳng vào `dev.db` từng dòng, nghỉ ít nhất 5 giây giữa các dòng (`push_core.sh`, `scripts/push-shared-prints.mjs`, `scripts/lib/push-local-renders.mjs`, `scripts/vps/apply_chunk.py` trong worktree `peaceful-villani-d3d860`).
- Vì ghi SQL thẳng nên các luồng phải giữ chung một khoá `.push-lock`. Ngày 11/12 có 10 dòng đã xong phải chờ 08:50 → 10:43; ngày 11/13 một luồng chờ gần 2 giờ.
- Máy nào muốn đẩy cũng phải giữ chìa khoá SSH root của VPS và refresh token Google Drive (đọc từ bản sao DB). PC thứ hai không nên giữ hai thứ đó.
- File thật ra **không đi qua VPS**: máy local upload thẳng lên Drive. VPS chỉ nhận vài dòng dữ liệu cho mỗi file.

Số đo 30 ngày trên prod (đọc ngày 11/15, 2.320 dòng, 301 mã thiết kế): từ lúc có task đến lúc có file in đầu tiên, trung vị 21,6 giờ; 11% trong 2 giờ; 52% trong 24 giờ; 27% quá 72 giờ.

## 2. Mục tiêu

1. Dòng làm xong ở local hiện trên tool trong vòng 1 phút, không chờ luồng khác.
2. Nhiều luồng và nhiều máy giao cùng lúc; không còn `.push-lock` cho việc giao file.
3. Máy giao file chỉ cần worker token (thu hồi được). Không SSH, không refresh token Drive ở máy local.
4. Cùng kết quả cho người dùng như cách đẩy hiện nay: dòng có file in và mockup trên tool, đúng thư mục Drive, đúng event. Chỗ nào cố ý khác script cũ được ghi ở mục 7.3 và mục 10.
5. VPS nhẹ hơn hiện nay: không sao lưu cả DB cho mỗi lượt, không byte file in nào đi qua VPS.

## 3. Ngoài phạm vi

- Cài đặt PC thứ hai, token riêng từng máy, trang theo dõi máy (giai đoạn 2).
- Render theo sự kiện thay cho chu kỳ 1 giờ (giai đoạn 3).
- Gom nhiều dòng vào một lần chạy Photoshop (giai đoạn 4).
- Thay đổi luồng duyệt của nhân viên, giao diện Design Studio.
- Đường giao của Designer Agent runner (`/api/design-agent/runner/*`) giữ nguyên.
- Sửa link file đã gửi cho xưởng, cập nhật dòng thư viện: API này không làm (quy tắc chủ shop 11/06: dòng đã gửi xưởng thì không viết lại sheet).

## 4. Điều không được xảy ra

- Giao dở dang: file cũ biến mất khỏi Drive mà DB vẫn liệt kê (đã xảy ra với LIT6489_1), hoặc ngược lại.
- Mất file mà xưởng đang cầm link: link xưởng là link từng file (`OrderLine.designDriveLink`, `Order.designDriveLink`, `SkuSupplierDesign.designLink`), đơn sau còn dùng lại link thư viện mà không có dòng `DesignArtwork` nào.
- File chưa được ghi nhận nằm trong thư mục task, nơi xưởng nhìn thấy (ngày 11/12 một bảng QA đã bị gửi cho PGprints).
- Ghi đè việc của người: file in do nhân viên upload bị gỡ mà không ai yêu cầu; trạng thái nhân viên vừa đổi bị đè.
- Gỡ file in cuối cùng của một dòng (trừ action `revert`).
- VPS hết RAM hoặc khởi động lại vì giao hàng loạt.
- Cùng một lần giao được ghi hai lần khi máy gửi lại.

## 5. Ràng buộc

- Quy tắc API trong `CLAUDE.md`. `/api/design-studio/worker/` đã là `PUBLIC` trong `API_ACCESS_RULES` (`src/lib/api-access.ts:76`) và từng route tự kiểm token bằng `verifyWorkerRequest` (`src/lib/artwork-worker.ts`).
- SQLite một người ghi. PM2 chạy `podmanager` ở fork mode, **một tiến trình**, giới hạn 1400 MB (đọc trên VPS 11/15); hàng chờ trong tiến trình ở mục 7.4 dựa vào điều này.
- nginx: `location /api/design-studio/` cho body 1100 MB, timeout 900 giây (đọc trên VPS 11/15); route mới nằm dưới đó nên không sửa nginx.
- VPS 3,8 GB RAM, ổ đĩa 75 GB đã dùng 88%.
- Không thêm bảng, không migration.
- Test không đụng `dev.db`; mọi gọi Drive trong test đi qua một lớp giả.
- Deploy theo quy trình hiện có; so `main` với bản đang chạy trước khi deploy.

## 6. Các hướng đã cân nhắc

| | Cách làm | Được | Mất |
|---|---|---|---|
| **A. API đăng ký file (chọn)** | Local upload Drive, rồi gọi API gửi mã file; server tự kiểm tra và ghi | Bỏ khoá, bỏ SSH, file hiện ngay, một bộ quy tắc nằm trên server | Phải viết API + deploy; lưới "chạy thử trên bản sao" thay bằng kiểm tra trong code và test |
| B. Hộp chờ + đồng bộ 15 phút qua SSH | Gom các dòng, một chương trình đẩy cả đợt bằng đường SSH cũ | Gần như không đụng server | Vẫn SSH root, vẫn sao lưu DB mỗi đợt, vẫn chậm tới 15 phút, một đợt lỗi ảnh hưởng nhiều dòng |
| C. Gửi cả file qua route upload có sẵn | Local gửi byte file lên VPS, VPS đẩy Drive | Không viết gì mới | File in 100 MB đi qua VPS yếu (route file từng gây tràn RAM), truyền hai lần |

Chủ shop chọn A ngày 2026-11-15 ("các phần khác anh đồng ý triển khai như em đã nói", sau khi được đề xuất A).

## 7. Thiết kế

### 7.1 Các bước của một lần giao (một dòng đơn)

1. **Hỏi trạng thái**: máy local hỏi server về task (thay cho bản sao DB cũ).
2. **Upload vào thư mục chờ**: máy local upload file lên Drive bằng access token ngắn hạn do server cấp, vào thư mục chờ riêng của task (`<root>/_incoming/<taskKey>`), **không** vào thư mục task.
3. **Ghi nhận**: máy local gửi danh sách mã file Drive. Server kiểm tra, chuyển file từ thư mục chờ vào thư mục task, ghi DB trong một transaction, rồi dời file cũ sang `_old`.

Nhờ thư mục chờ, file bị từ chối hoặc bỏ dở không bao giờ xuất hiện trong thư mục task, và máy local không phải xoá gì trên Drive.

### 7.2 Route mới (đều dưới `/api/design-studio/worker/delivery/`, kiểm worker token)

**`POST drive-token`** → `{ accessToken, expiresAt }`. Dùng `getAccessToken` (`src/lib/google-drive.ts:76`), mở rộng để trả thêm thời điểm hết hạn. Máy local không còn đọc `google.oauth.clientSecret` / `google.drive.refreshToken`.

**`GET tasks/[key]`** → trạng thái sống của task:
- `status`, `readiness`, `orderOpen`, `sent` (đã gửi xưởng chưa);
- `folder { id, url }`: nếu task chưa có thư mục thì server tạo theo `taskFolderPath` (`root / <project hoặc shop> / <YYYY-MM của placedAt> / <số đơn> / <taskKey>`), chia sẻ "anyone, reader", lưu vào `DesignTask.driveFolderId/Url`;
- `incomingFolder { id }`: thư mục chờ, server tạo nếu chưa có;
- `artworks[]`: các dòng `DesignArtwork` đang sống của dòng đơn `{ id, kind, printArea, version, source, uploadedById, driveFileId, sharedWith }` (`sharedWith` = số dòng đơn khác đang có dòng sống cùng `driveFileId`);
- `nextVersion { "<kind>/<printArea>": n }` = max(version, kể cả đã gỡ) + 1;
- `required[]`: các phần file in bắt buộc, từ `requiredSlotsForLine` (`src/lib/design-tasks.ts:1313`), không dùng `uploadSlotsForLine` vì hàm đó trả cả các bộ thay thế.

**`POST tasks/[key]/commit`** — body:

```json
{
  "action": "push | replace | retire | revert",
  "expected": { "status": "NEW", "liveIds": ["..."] },
  "files": [{ "kind": "PRINT | MOCKUP", "printArea": "front", "fileName": "front.jpg",
              "driveFileId": "...", "shortcutOf": null,
              "size": 123, "mimeType": "image/jpeg", "widthPx": 1, "heightPx": 1 }],
  "retire": ["<artworkId>"],
  "retireSources": ["AUTO"],
  "allowFinished": false,
  "revertReadiness": "MANUAL",
  "eventMessage": "...",
  "dryRun": false
}
```

Trả `{ ok, status, artworks[], retired[], missing[], alreadyApplied }` hoặc `{ error, code, current }` với mã HTTP 400 / 404 / 409 / 503.

**`PUT artworks/[id]/preview`**: ảnh xem trước JPEG 2000 px cho file từ 30 MB (thay cho `scp` vào `storage/design/_previews`), giới hạn 4 MB như hiện có (`src/lib/design-storage.ts:202`), server tự đặt `previewPath`.

### 7.3 Quy tắc của `commit` (server quyết, máy local không tự ghi gì)

Thứ tự kiểm tra:
1. **Đã ghi rồi?** Nếu mọi file trong `files` đã có dòng sống cùng `driveFileId` ở đúng phần, và mọi dòng trong `retire` đã gỡ, trả `alreadyApplied: true` ngay, **trước** khi so `expected` (lần gửi lại sau khi mất phản hồi sẽ mang `expected` cũ).
2. So `expected.status` và `expected.liveIds` với hiện trạng; lệch thì 409 kèm `current`, không ghi gì.
3. Mỗi `driveFileId` được server hỏi Drive: tồn tại, không ở thùng rác, đúng `size`, và đang nằm trong thư mục chờ của task (hoặc đã ở thư mục task). File dùng chung của đơn không custom gửi bằng `shortcutOf: <driveFileId gốc>`: file gốc phải là file in sống của một dòng khác; server tạo lối tắt trong thư mục task, không chuyển file gốc.
4. Chặn layout cũ của template (`PrintTemplate.altAreas.filesUntil`, quy tắc chủ shop 11/04): file có kích thước của layout đã hết hạn thì 400, dùng `src/lib/print-file-fit.ts`. Lệch kích thước kiểu khác không chặn (script cũ cũng không chặn), chỉ trả trong `warnings[]`.

Ghi:
- Server tự sinh `id`, `version`, `createdAt`. Dòng mới: `storage='DRIVE'`, `storagePath=NULL`, `drivePlace='TASK'`, `source='AUTO'`, `uploadedById=NULL`.
- Server chuyển file từ thư mục chờ vào thư mục task và đặt tên theo quy tắc hiện có (`<printArea an toàn>.<đuôi>`, mockup thêm tiền tố `MOCKUP_`).
- Mockup: `kind='MOCKUP'`, không bao giờ đụng dòng PRINT.
- Một transaction DB cho cả dòng đơn, ghi **trước**; ngay sau đó server gọi bộ dọn thư mục có sẵn (`tidyTaskFolder`) để chuyển file mới từ thư mục chờ vào thư mục task. Chuyển lỗi thì dòng DB vẫn đúng (file mở được theo mã), và lượt dọn định kỳ làm lại. (Sửa 11/15 khi lập kế hoạch: bản trước ghi "Drive lỗi thì không ghi DB"; dùng lại `tidyTaskFolder` an toàn hơn vì DB là nguồn sự thật và việc dời file có sẵn cơ chế thử lại.)
- File bị gỡ **không bao giờ bị xoá hay vào thùng rác**: sau khi DB đã ghi, server dời nó sang `<Order>/_old/<TaskKey>` theo đúng quy ước của app (`src/lib/task-folder.ts:94-101`). Link từng file mà xưởng đang cầm vì thế vẫn mở được. File có `sharedWith > 0` thì để nguyên, chỉ gỡ lối tắt trong thư mục task. `drivePlace='OLD'` chỉ được đặt khi đã dời xong; chưa dời xong thì bộ dọn thư mục có sẵn (`tidyTaskFolder`) làm tiếp.
- Chuyển trạng thái dùng đường của app dành cho auto/agent (`submitAutoRenderForReview`, `submitAgentForReview`), không viết SQL tay. Event ghi `actorId=NULL` như hiện nay; hàm nào bắt buộc có actor thì dùng user hệ thống "Design Agent" có sẵn.

`push` (dòng chưa có file in):
- Nhận khi task ở NEW, ASSIGNED, DOING hoặc REJECTED và không có PRINT sống.
- Đủ mọi phần trong `required`: chuyển sang REVIEW, `readiness='AUTO'`, event ARTWORK (`eventMessage` hoặc "Render tự động…") và event SYSTEM như hiện nay.
- Thiếu phần: file vẫn được ghi, **task giữ nguyên trạng thái**, trả `missing[]`. Lần `push`/`replace` sau bổ sung đủ thì mới lên REVIEW. (Script cũ ép lên REVIEW bằng SQL; app thì không cho, `design-tasks.ts:825-834`. Bản này theo app.)

`replace` (dòng đã có file in):
- Nhận khi task ở REVIEW, DOING, REJECTED; ở DONE chỉ khi `allowFinished=true`.
- Gỡ các dòng trong `retire`, thêm file mới với version kế tiếp.
- Chỉ gỡ file có `source` thuộc `retireSources` (mặc định `["AUTO"]`); file do người upload (`source='MANUAL'`) cần `retireSources` có `"MANUAL"`.
- Task ở REJECTED hoặc DOING và đủ `required`: chuyển sang REVIEW, event "Gửi duyệt lại" (quy tắc chủ shop 11/06 và 11/13; script cũ giữ nguyên trạng thái rồi phải chạy bước phụ). Task ở REVIEW hoặc DONE: giữ nguyên trạng thái, một event ARTWORK "… · thay <các phần>".
- Không còn cần đặt `readiness='AUTO'` trước khi đẩy và né mốc đồng bộ 15 phút.

`retire` (chỉ gỡ): như `replace` không có file; từ chối nếu gỡ xong dòng không còn PRINT sống nào.

`revert` (rút một lần auto render sai, thay cho `--revert` của script): chỉ nhận khi task ở REVIEW, `readiness='AUTO'` và mọi PRINT sống có `source='AUTO'`; gỡ hết các file đó, đưa task về NEW với `readiness = revertReadiness`, một event SYSTEM.

### 7.4 Bảo vệ VPS

- Mọi `commit` chạy lần lượt qua một hàng chờ trong tiến trình, cách nhau tối thiểu 300 ms. Đây là code mới: `job-lock.ts` bỏ qua khi bận chứ không xếp hàng; chuỗi promise trong `tidyTaskFolder` là mẫu gần nhất.
- Trước mỗi `commit`: nếu RSS của tiến trình trên 1100 MB hoặc RAM trống của máy dưới 600 MB thì trả 503 kèm `Retry-After: 60` (thay cho bước kiểm pm2/RAM qua SSH hiện nay).
- Dọn thư mục chờ: thư mục `_incoming/<taskKey>` không còn file thì xoá; file nằm đó quá 7 ngày thì xoá hẳn (đó là bản upload chưa từng được ghi nhận, máy local còn bản gốc).
- Sao lưu DB: bỏ sao lưu theo từng lượt đẩy. Thay bằng **một sao lưu định kỳ mỗi giờ** trên VPS (`VACUUM INTO /root/db-backups/`, giữ 30 bản mới nhất, khoảng 5,6 GB như hiện nay). Root hiện không có crontab nào; thêm lịch này là thay đổi cấu hình server, làm khi deploy với sự đồng ý của chủ shop.

### 7.5 Phía máy local

- `scripts/lib/delivery-client.mjs`: các lời gọi trên + upload Drive resumable có sẵn (`scripts/lib/drive-rest.mjs`, đổi nguồn token sang `drive-token`).
- `push-local-renders.mjs` và `push-shared-prints.mjs` thêm `--via api` (về sau là mặc định) và `--via ssh` (đường cũ, giữ 2 tuần làm dự phòng). Phần lập kế hoạch dùng `GET tasks/[key]` thay cho bản sao DB. `--revert` gọi action `revert`.
- Máy local **không xoá, không đưa vào thùng rác bất cứ thứ gì trên Drive**. Dòng bị từ chối: ghi lý do vào ledger và in ra; file nằm lại thư mục chờ.
- Ledger hiện có (`ledger.json`) tiếp tục là "hộp chờ gửi": ghi mã file Drive ngay sau upload, trước khi `commit`. Gặp 409 thì đọc lại `GET tasks/[key]` rồi mới quyết định (không tự gửi lại mù). Gặp 503 hoặc mạng rớt thì thử lại theo `Retry-After`, tối đa 30 phút, rồi dừng với ledger nguyên vẹn; chạy lại lệnh là gửi tiếp, không upload lại. Không có chương trình gửi nền riêng.
- Upload Drive chạy song song (mặc định 3 file); `commit` của một máy gửi lần lượt.
- `tools/auto-render-hourly/auto_render.py` và các script đẩy của luồng (`push_core.sh`, `push_s2n.sh`) chuyển sang `--via api` và bỏ `.push-lock`.

### 7.6 Kiểm thử và nghiệm thu

- Test tích hợp trên `test.db` cho từng action và từng điều ở mục 4: lệch `expected`, gửi lại hai lần (kể cả với `expected` cũ), gỡ file cuối, file dùng chung, file của người, file đang là link xưởng, task DONE, thiếu phần, layout cũ, Drive lỗi giữa chừng.
- Test đối chiếu với `apply_chunk.py` chỉ cho hai trường hợp bản này giữ nguyên hành vi: `push` từ NEW đủ phần, và `replace` ở REVIEW. So các dòng `DesignArtwork` / `DesignTask` / `DesignTaskEvent`, trừ `id`, `createdAt`, `previewPath`.
- Trên prod, theo thứ tự: (1) deploy, route tắt bằng `AppSetting delivery.api.enabled=false`; (2) 20 dòng chạy `dryRun` song song với đường cũ, so kết quả; (3) 10 dòng thật có người theo dõi; (4) bật cho auto render hằng giờ; (5) bật cho các luồng và bỏ `.push-lock`.
- Đạt khi: 3 luồng giao cùng lúc 50 dòng không dòng nào chờ khoá, PM2 không khởi động lại, mỗi dòng có đủ file trong thư mục task và đúng dòng trên tool, thư mục task không có file lạ.

## 8. Để người xây quyết

- Tên hàm, cách chia file trong `src/lib/`, dạng lỗi chi tiết.
- Cách bọc Drive để test (interface hay tham số).
- Các hàm Drive còn thiếu trên server (tạo lối tắt; dời file đã có trong `task-folder.ts`). Server hiện chỉ có `deleteFile` là xoá hẳn (`src/lib/google-drive.ts:347`); chỉ dùng nó cho việc dọn thư mục chờ.
- Số lần và khoảng cách thử lại phía máy local, trong giới hạn 30 phút.

## 9. Các giai đoạn sau (chưa thiết kế chi tiết)

2. **PC2 thành xưởng 24/7**: token riêng từng máy, chuyển auto render / Designer Agent runner / Clone runner / theo dõi familystore sang PC2, trang "máy nào đang làm gì".
3. **Render theo sự kiện**: đơn AUTO mới về thì máy nhận ngay (request giữ 25 giây như Clone runner) thay cho chu kỳ 1 giờ.
4. **Photoshop**: gom các dòng cùng PSD vào một lần mở file; Python trước cho việc hàng loạt; làn Photoshop thứ hai trên PC2. (Ý "PSD tên thu nhỏ" đã bị chủ shop bác ngày 11/15.)
5. **Ưu tiên thư viện theo số đo**: 13 mã chiếm 50% số dòng chậm trong 30 ngày (PK05111508, DN1610261054, TN0709261453, TN2605261712, DN1210261516, HB22041448, PK28041053…); "(không SKU)" 159 dòng và nhóm Reminiso `RM` 76 dòng cần tách riêng.
6. **Dọn ổ VPS tự động**: `tmp/` của phiên làm việc, các bản `.next.predeploy-*`, bản sao lưu đặt tên tay.

## 10. Những điểm do người viết tự quyết (chủ shop chưa nói)

1. Dòng thiếu phần file in **không** được ép lên Chờ duyệt (khác script cũ, theo đúng quy tắc của app).
2. File cũ được dời sang `_old`, không vào thùng rác (khác script cũ, theo quy ước của app, giữ link xưởng còn sống).
3. Upload vào thư mục chờ `_incoming`, server mới chuyển vào thư mục task; file chờ quá 7 ngày bị xoá hẳn.
4. `push` nhận cả ASSIGNED/DOING/REJECTED (script cũ chỉ nhận NEW); `replace` trên REJECTED/DOING tự lên Chờ duyệt.
5. Giữ action `revert`.
6. Không có chương trình gửi nền; ledger + chạy lại lệnh là đủ.
7. Chống ghi trùng bằng `driveFileId`, không thêm bảng.
8. Giai đoạn 1 dùng worker token hiện có (một token); token riêng từng máy để giai đoạn 2.
9. Sao lưu mỗi giờ, giữ 30 bản.
10. Ngưỡng 1100 MB / 600 MB và khoảng cách 300 ms.
