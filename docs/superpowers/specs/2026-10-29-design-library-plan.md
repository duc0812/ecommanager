# Thư viện thiết kế: template, mockup xưởng, artwork, font

Ngày: 29/10/2026. Trạng thái: plan. Chủ shop đã chốt 4 điểm ở mục 8 cùng ngày 29/10.

Mục tiêu:
- **Mỗi sản phẩm của mỗi xưởng** có template in và mockup PSD của chính xưởng đó.
- **Mỗi SKU × variant × xưởng** có artwork đã duyệt (file in phẳng, file in không chữ + font, hoặc PSD), kèm font.
- **Đơn mới tìm ra file dùng lại trong vài giây,** không phải lục NAS, Trello hay Drive.
- **Tất cả nằm trong một thư mục gốc duy nhất,** và chỉ nhận file qua tool có kiểm tra.

---

## 1. Hiện trạng (đếm trên prod và máy văn phòng ngày 29/10/2026)

### Số liệu

| Hạng mục | Số liệu | Vấn đề |
|---|---|---|
| Template in (`PrintTemplate`) | 52 (Mango 22, Jomall 12, Merchize 11, PGprints 4, Printway 2, Bondre 1) | Chỉ 4 template có artguide, 1 có file nguồn. Chỉ 116 trên 1.091 variant xưởng được gắn template. |
| Mockup PSD của xưởng | 0 trong tool | Nằm rải rác trên Drive xưởng: Mango "WZ-袜子 / 效果图模板", Merchize "mockup_and_templates_link". Mỗi lần cần lại phải tải về. |
| Artwork Library (`ArtworkEntry`) | 4 READY trên prod (93 dòng render ở máy local) | Mới phủ vài sản phẩm custom. |
| File in đã làm (`DesignArtwork`) | 2.993 file in, khoảng 25 GB trên Drive; 908 mockup | Lưu theo đơn (LIT…), không theo SKU/variant, nên khó dùng lại. |
| Font (`DesignFont`) | 1 | Font nằm trong PSD, trên máy designer, hoặc trang Customall. Mỗi đơn phải dò lại. |
| PSD | NAS `\\TMTEAM\TEMPLATE\2026` (theo tháng, T5…T10, MERCHIZE…), `D:\Ecom manager\artwork-builder\<SKU>` (dựng bằng AI và Photoshop), Drive designer, Trello cũ | Không có quy ước tên. Cùng một mã nằm ở 3–4 nơi. |

### Thời gian đang mất ở mỗi mẫu
1. Tìm PSD hoặc template đúng: lục NAS, Trello, Drive, rồi hỏi designer.
2. Xác định đúng blank: Crewneck hay V-Neck, kid hay adult, hoodie hay zip.
3. Tìm font.
4. Tải mockup PSD của xưởng để QA.
5. Gỡ khóa duyệt do tên vùng in lệch.

---

## 2. Một thư mục gốc duy nhất: `\\TMTEAM\TEMPLATE\LIBRARY`

Thư mục nằm trong share TEMPLATE đang dùng. Designer **không ghi thẳng** vào đây: mọi file vào thư viện đều đi qua tool và bước kiểm tra (mục 3.1). Chỉ worker ở máy văn phòng ghi vào thư mục này.

```
TEMPLATE\LIBRARY\
  _staging\                       ← file nộp qua tool đang chờ kiểm tra/duyệt (worker ghi, không ai sửa tay)
  _fonts\
    <Family>\<Family>-<Style>.otf|ttf
    fonts.json                    ← family, style, postscript, nguồn (Customall id / dafont / mua), license
  suppliers\
    <XƯỞNG>\<BLANK>\              ← vd. MERCHIZE\MWHDVN, MANGO\WZ, JOMALL\CREWNECK, MERCHIZE\11MMUS
      blank.json                  ← tên, mã SKU xưởng, size, màu, phương pháp in, link nguồn xưởng, luật riêng (mục 5)
      template\
        <BLANK>_<SIZE|ALL>_v<YYYYMMDD>.psd|tif   ← template gốc của xưởng (1 file / size hoặc ALL)
        <BLANK>_<SIZE|ALL>_cutlines.png          ← đường cắt + vùng an toàn (làm artguide)
      mockup\
        <BLANK>_<GÓC>_v<YYYYMMDD>.psd            ← mockup PSD của xưởng; smart object tên chuẩn DESIGN / DESIGN_BACK…
        mockup.json                              ← smart object nào nhận vùng in nào
      _old\
  products\
    <MÃ SP>\                      ← DN1907262114, TN0309261821, HB21041432…
      product.json                ← tên, store, link, danh sách variant → xưởng/blank (bản chụp mapping)
      reference\                  ← ảnh listing, mockup gốc, preview khách (để QA)
      artwork\
        <SKU>-<Variant1>-<Variant2>-<XƯỞNG>-<YYYYMMDD>\
          print\<VÙNG>.png|tif    ← file in phẳng đúng template (sản phẩm không custom: dùng luôn)
          base\<VÙNG>.png|tif     ← file in KHÔNG có chữ custom (sản phẩm custom chữ): chỉ cần thêm chữ là in được
          text.json               ← mỗi field: font, cỡ, màu, viền, vị trí/khung, căn lề, cong/warp, chữ mẫu đã duyệt
          master.psd              ← PSD gốc (khi có); layer text đặt tên @<Field>
          mockup\<GÓC>.jpg        ← mockup dựng từ file in bằng PSD xưởng (QA)
          asset.json              ← loại asset, font, field, template/version, đơn nguồn (LIT…), kết quả kiểm tra, người duyệt
      _old\
```

### Quy tắc đặt tên thư mục artwork
- **Định dạng:** `SKU-Variant1-Variant2-Xưởng-NgàyThángNăm`, ví dụ `DN1907262114-HOODIE-TURQUOISE-MERCHIZE-20261029`.
- **Variant không đổi artwork** (vd. size, khi sheet dùng chung mọi size) ghi `ALL`: `DN2508261111-VNECK-ALL-JOMALL-20261029`.
- **Ngày** là ngày duyệt. Bản mới không ghi đè mà tạo thư mục ngày mới; bản cũ vào `_old` khi bị thay.
- **Không dấu, không khoảng trắng,** viết HOA.
- **Tên variant chuẩn hóa dần** (mục 4.4). Thư mục cũ giữ tên cũ, bảng alias trỏ tới nó; tool có nút đổi tên thư mục khi variant đó đã chuẩn hóa.

### Chuyển dữ liệu cũ sang (giai đoạn 1)
- **Copy, không di chuyển.** Script sao `\\TMTEAM\TEMPLATE\2026\MERCHIZE`, `D:\Ecom manager\artwork-builder\*`, `clipart-clones`, `clipart-originals` vào đúng chỗ, với trạng thái "chưa kiểm tra". Kèm báo cáo các file không xác định được mã.
- **Giữ thư mục cũ** cho tới khi anh xác nhận.

---

## 3. Database trong tool: chỉ lưu metadata, file nằm ở NAS

Tool không giữ PSD hay mockup xưởng. Worker ở máy văn phòng làm mọi việc nặng trên NAS; tool chỉ biết **file nào ở đâu, cho variant nào, đã kiểm tra và duyệt chưa**.

### Bảng

| Bảng | Một dòng là | Trường chính |
|---|---|---|
| `SupplierBlank` (mới) | 1 blank của 1 xưởng (MERCHIZE/MWHDVN) | `supplierId`, `code`, `name`, `nasDir`, `sizes`, `colors`, `rules`. Gom các `SupplierProduct` cùng blank. |
| `PrintTemplate` (có sẵn, thêm trường) | 1 template in | Thêm `blankId`, `sizeScope` (ALL hoặc danh sách size), `version` (ngày), `nasPath`, `cutlinesPath`, `status` (ACTIVE/RETIRED). Tên vùng in là chuẩn mà file in phải theo đúng, kể cả hoa/thường. |
| `SupplierMockup` (mới, chỉ metadata) | 1 mockup PSD của xưởng | `blankId`, `view` (FRONT/BACK/SIDE…), `nasPath`, `smartObjects` (smart object → vùng in), `version`. |
| `ArtworkAsset` (thay dần `ArtworkEntry`) | 1 bộ artwork | `productCode`, `sku`, `variantKey` (chuẩn hóa dần), `supplierId`, `blankId`, `templateId` + version, `kind` (FLAT_PRINT / BASE_PLUS_TEXT / CUSTOM_PSD), `nasDir`, `sha256`, `fields`, `textSpec`, `fonts`, `status` (STAGING / CHECK_FAILED / WAITING_APPROVAL / APPROVED / RETIRED), `checks`, `sourceOrder` (LIT…), `submittedBy`, `approvedBy`, `approvedAt`. |
| `FontAsset` (thay `DesignFont`) | 1 file font | `family`, `style`, `postscript`, `nasPath`, `sha256`, `source`, `license`. |
| `VariantAlias` (mới) | 1 cách gọi variant | `raw` ("9 x 30 cm (For Kid)") → `normalized` (KID), theo store hoặc sản phẩm; `folderRenamed` (đã đổi tên thư mục chưa). |

Dữ liệu đơn hàng giữ như hiện tại (`DesignArtwork` vẫn là file của từng đơn).

### Ba loại asset, xếp theo tốc độ xử lý
- **FLAT_PRINT:** sản phẩm không custom. File in phẳng được lưu, đơn sau dùng lại luôn link.
- **BASE_PLUS_TEXT:** sản phẩm custom chữ (đa số). Lưu file in **không có chữ** (`base\`) và mô tả chữ (`text.json`). Đơn mới chỉ cần vẽ tên lên base, nhanh hơn nhiều so với mở PSD.
  - **Font là phần bắt buộc:** asset không vào được thư viện nếu font chưa có trong `_fonts`.
- **CUSTOM_PSD:** sản phẩm custom hình hoặc nhiều lớp (chọn nhân vật, đổi màu theo variant…), cần render PSD master.

### 3.1 Nộp file qua tool và kiểm tra trước khi vào thư viện

Designer nộp bằng nút "Lưu vào thư viện" trên task (sau khi đơn được duyệt), hoặc trên trang Thư viện. Không ai chép tay vào NAS.

1. **Chọn:** tool đã biết sản phẩm, SKU, variant, xưởng và template từ dòng đơn, nên tự đặt tên thư mục. Designer chỉ chọn loại asset và tải file.
   - FLAT_PRINT: file in.
   - BASE_PLUS_TEXT: base, font, rồi điền vị trí và kiểu chữ (hoặc tải PSD để tool đọc ra `text.json`).
   - CUSTOM_PSD: PSD và font.
2. **Đặt chỗ:** file vào `_staging`. Worker ở máy văn phòng kéo về, kiểm tra, rồi trả kết quả từng mục lên tool.
3. **Kiểm tra tự động:**
   - **Mọi loại:**
     - khổ px, dpi, hệ màu đúng template từng vùng;
     - tên vùng khớp template (kể cả hoa/thường);
     - đủ mọi vùng;
     - không vượt vùng an toàn (cảnh báo).
   - **CUSTOM_PSD (layer custom):**
     - có đủ layer @Field cho mọi field khách nhập của sản phẩm (đối chiếu field Customall/YMQ/builder, tên field giữ như bản cũ);
     - layer @Field là layer text thật, không bị rasterize;
     - không còn chữ mẫu ở layer ẩn hoặc hiện;
     - render thử với chữ dài nhất từng gặp mà chữ không tràn khung;
     - mọi font PSD dùng đều có trong `_fonts`, thiếu thì chặn.
   - **BASE_PLUS_TEXT:**
     - base không còn chữ custom (so với bản in cũ có chữ);
     - `text.json` đủ font, cỡ, màu, vị trí;
     - render thử một tên ngắn và một tên dài, đặt cạnh mockup listing.
   - **Mockup QA:** dựng từ PSD mockup của xưởng (nếu blank đã có), đặt cạnh mockup listing hoặc preview.
4. **Duyệt:** leader xem ảnh kiểm tra và bấm duyệt. Lúc đó worker mới chuyển từ `_staging` vào đúng thư mục `SKU-Variant1-Variant2-Xưởng-Ngày`. Bản cũ cùng chỗ vào `_old`.
5. **Không đạt:** trả lại designer kèm lý do từng mục; file vẫn ở `_staging`.

Khi một đơn được duyệt mà chưa có asset cho SKU/variant/xưởng đó, tool gợi ý "Lưu vào thư viện" (không tự lưu).

---

## 4. Kiến trúc truy xuất nhanh

### 4.1 Chỉ mục hai tầng
- **Ở máy văn phòng:** worker quét `LIBRARY` (nhanh nhờ cache hash theo path + size + mtime, như `nas.py` đang làm), giữ một chỉ mục SQLite local và đẩy metadata lên tool. File không rời NAS. Bản sao nóng lưu trên SSD theo sha256.
- **Trên tool:** các bảng ở mục 3 có index theo `(productCode, variantKey, supplierId)` và `(blankId)`. Tra một đơn chỉ là 1–2 query.

### 4.2 Thứ tự tìm file cho một dòng đơn mới
1. **Khớp tuyệt đối:** `ArtworkAsset` APPROVED cùng SKU, variant và xưởng.
   - FLAT_PRINT: dùng lại luôn link file in (quy tắc "no-custom = one link").
   - BASE_PLUS_TEXT: vẽ tên lên base bằng font đã lưu (không cần Photoshop mở PSD), rồi QA.
   - CUSTOM_PSD: render PSD master.
2. **Cùng sản phẩm, variant khác nhưng cùng sheet** (Mango sheet chữ nhật dùng cho mọi size, áo kid KWY…): dùng lại theo luật trong `blank.json`.
3. **Cùng mã thiết kế, xưởng khác:** báo "cần dàn lại theo template X", đính kèm asset gần nhất.
4. **Không có gì:** mở task cho designer, đính sẵn ảnh listing, template và cutlines đúng size, asset gần nhất, font và mockup PSD xưởng. Designer không phải đi tìm.

### 4.3 Kiểm tra trước khi giao việc
Mỗi sản phẩm có trạng thái sẵn sàng 5 ô: Template, Mockup xưởng, Artwork, Font, Mapping variant. Trang tổng hợp lọc được "sản phẩm đang có đơn nhưng thiếu ô nào". Worker quét lại mỗi đêm, hoặc khi anh bấm.

### 4.4 Chuẩn hóa variant (làm dần)
Bảng `VariantAlias` đổi mọi cách ghi về một mã: `Hoodie / Red / S` → `HOODIE-RED-S`, `9 x 30 cm (For Kid)` → `KID`, `Knitted Cardigan V-Neck` → `VNECK`.
- **Lợi ích:** tên thư mục đúng một kiểu, luật dùng lại sheet chạy đúng, không còn chọn nhầm template do đọc mỗi SKU.
- **Thời gian chuyển:** tra theo cả tên cũ lẫn mã chuẩn. Mỗi lần một sản phẩm có đơn, tool đề xuất mã chuẩn; anh hoặc leader xác nhận thì đổi tên thư mục.

### 4.5 Một lệnh xử lý đơn
Mở rộng `process-new-orders` thành chuỗi: snapshot → tra thư viện (4.2) → render (BASE_PLUS_TEXT bằng font, CUSTOM_PSD bằng Photoshop local) → dựng mockup từ PSD xưởng → ảnh QA (file in, mockup xưởng, mockup listing đặt cạnh nhau) → đẩy REVIEW, mỗi chunk một dòng → anh duyệt trên prod.
- **Song song:** 2–3 việc một lúc. Photoshop mở một lần, dùng cho nhiều việc.

---

## 5. Kinh nghiệm rút ra khi làm mẫu (đưa thành luật trong tool)

1. **Đọc tên sản phẩm và variant trước khi chọn template,** không chỉ đọc SKU. Đã nhầm Crewneck với V-Neck, kid với adult, hoodie với zip, và áo len P-nust bị map nhầm sang Hoodie. Template phải gắn với blank và size, kèm ảnh nhận diện.
2. **Một sheet có thể có nhiều đường cắt khác tỉ lệ** (túi QTTB, size M khác L): template theo size range, kèm cutlines để phủ lên kiểm.
3. **Tên vùng in phải khớp template từng chữ,** kể cả hoa/thường. Lệch tên làm khóa duyệt và để file cũ nằm lại thư mục xưởng (20 dòng ngày 29/10). Kiểm tra ngay lúc nộp.
4. **Pin template trong profile sản phẩm thắng mọi luật SKU,** nên phải hiện rõ; pin sai từng khóa 10 dòng.
5. **Font lấy từ nguồn,** theo thứ tự: OTF mà Customall tải về; nếu không có thì so ứng viên với bản in cũ. Lưu font cạnh artwork, ghi license (Lastgirl chỉ là bản demo).
6. **Thay PSD thì giữ tên @Field cũ,** nếu không thì render mất chữ (LIT5541).
7. **Không custom thì dùng một link** cho mọi đơn của thiết kế đó; không upload một bản cho mỗi đơn.
8. **Vẽ lại bằng AI:**
   - Dùng GPT Image 2.5 trước.
   - GPT từ chối nhân vật bản quyền (Pooh, Star Wars) thì chuyển sang seedream và ghi lại nguồn.
   - Họa tiết giả thêu, giả len phải giữ hiệu ứng.
   - Nền tách lớp riêng; không dùng content-aware fill, vì nó kéo chữ ra mép.
9. **Đặc thù từng loại hàng:**
   - **Vớ:** đế quay 180° và chẻ đôi ở đường nối.
   - **Cốc:** chữ nằm trong safe zone, in hai mặt ở 1/4 và 3/4 vòng cốc.
   - **Hoodie Jomall:** ô giữa trên của sheet là mặt ngoài mũ.
   - **Merchize:** cốc nhập về bị trống trường size.

   Ghi vào `blank.json` để worker tự kiểm.
10. **QA bằng mockup PSD của xưởng,** đặt cạnh mockup listing, trước khi đẩy. Bắt được lỗi logo cắt ở đường may và chữ sát mép.
11. **So file CMYK của designer phải qua ICC;** chuyển màu kiểu thô làm màu xỉn giả.
12. **Mỗi lần ghi prod, một dòng một chunk,** VPS yếu; worker và render chỉ chạy ở máy văn phòng.

---

## 6. Các giai đoạn

| Giai đoạn | Việc | Ước lượng |
|---|---|---|
| **1. Thư mục + font** | Tạo `\\TMTEAM\TEMPLATE\LIBRARY` theo mục 2. Script copy dữ liệu cũ vào đúng chỗ (trạng thái "chưa kiểm tra"), kèm báo cáo file lạc. Gom font từ PSD, Customall và máy designer vào `_fonts` (font là ưu tiên số 1). | 1–2 ngày |
| **2. Database + nộp file có kiểm tra** | Thêm bảng ở mục 3 và migration. Luồng nộp qua tool và các bước kiểm tra ở mục 3.1. Worker quét LIBRARY rồi đẩy metadata. Trang "Thư viện": tìm theo SKU, variant, xưởng; xem template, cutlines, mockup; duyệt asset. | 3–4 ngày |
| **3. Truy xuất** | Bộ tra 4.2 trong `process-new-orders`, kèm render BASE_PLUS_TEXT. Gợi ý lưu asset khi đơn được duyệt. Trang sẵn sàng 5 ô. Bảng chuẩn hóa variant (làm dần). | 2–3 ngày |
| **4. Bổ sung dần** | Mockup PSD cho các blank chạy nhiều (Merchize MWHDVN/T5HAVN/11MMUS, Mango WZ/GAF/BTX, Jomall CREWNECK/V-NECK). Cho dữ liệu cũ (trạng thái "chưa kiểm tra") qua bước kiểm tra theo đơn phát sinh. Chuẩn hóa variant và đổi tên thư mục dần. | làm dần theo đơn |

Mỗi giai đoạn chạy được độc lập. Giai đoạn 1 đã đỡ việc tìm file và font ngay cả khi chưa có giai đoạn 2.

---

## 7. Không làm
- **Tool không lưu PSD hay mockup xưởng,** chỉ lưu đường dẫn, hash và kết quả kiểm tra. File in của đơn vẫn lên Drive như hiện tại.
- **Không ai ghi tay vào `LIBRARY`;** chỉ worker ghi, sau khi qua kiểm tra và được duyệt.
- **Không xóa thư mục cũ** khi chưa có xác nhận.
- **Không tự đổi xưởng hay template trên prod** khi chưa có lệnh của anh.

## 8. Đã chốt với chủ shop (29/10/2026)
1. **Thư mục gốc** nằm trong share TEMPLATE: `\\TMTEAM\TEMPLATE\LIBRARY`.
2. **Designer nộp qua tool có kiểm soát,** để bảo đảm đúng cấu trúc. Trước khi lưu vào thư viện phải qua bước kiểm tra, ví dụ đã làm đúng layer custom chưa (mục 3.1).
3. **Lưu file in không custom** để xử lý nhanh khi cần. Với sản phẩm chỉ custom chữ, lưu file in không có chữ và lưu font, vì xử lý như vậy nhanh hơn mở PSD. Font là phần quan trọng nhất cần lưu.
4. **Variant chuẩn hóa dần,** đổi tên thư mục dần; bảng alias trỏ tên cũ sang tên chuẩn trong thời gian chuyển.
