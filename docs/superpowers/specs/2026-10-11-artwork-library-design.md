# Artwork Library — PSD gốc + font theo sản phẩm × template

**Status:** approved in chat 2026-10-11 ("dựng UI artwork library… render từ trang mapping… gắn thêm supplier"). Builds on Design Studio, product profiles, supplier print templates and Drive storage.

## Goal

Custom orders on our stores are customized text only. Like the Rosterpress artwork library (`D:\POD STORE NICHE 02\tools\artlib`), each product needs one approved artwork without the customer text, the fonts, and fixed positions for each custom field. Designers upload **one PSD per product × print template**. The tool reads the PSD **once** and stores the result. Later renders use only the light result (artwork PNG + font files + field JSON) and never reopen the PSD.

The library is driven by mapping. A product whose lines resolve to supplier A / template A shows a slot for template A, with the template's size and areas, so the designer knows exactly what to build. A product that goes to two suppliers (e.g. HaPo 20oz → PGprints, 30/40oz → Mangoshao) shows two slots. When a supplier changes, the new template gets a new empty slot, and the old entry stays valid.

Out of scope (next spec): rendering order print files from an entry, mockup PSDs and mockup rendering, auto-advancing tasks. Text warp / text on path is detected and flagged, but not rendered.

## Data

`LibraryFile`: one stored file.

| column | type | note |
|---|---|---|
| id | cuid | |
| kind | String | `PSD` · `ARTWORK` · `PREVIEW` · `FONT` |
| fileName / mimeType / size | | |
| sha256 | String | dedupe + integrity |
| storage | String | `LOCAL` · `DRIVE` |
| storagePath | String? | under `storageRoot()/library/...` |
| driveFileId / driveWebViewLink | String? | |
| uploadedById | String? | |
| createdAt | | |

`ArtworkEntry`: one slot product × template.

| column | type | note |
|---|---|---|
| id | cuid | |
| storeId | FK ShopifyStore | |
| shopifyProductId | String | product GID |
| printTemplateId | FK PrintTemplate | cascade delete |
| supplierId | FK Supplier | snapshot of `template.supplierId` |
| title / imageUrl | | product snapshot |
| status | String | `EMPTY` · `QUEUED` · `PARSING` · `NEEDS_FONTS` · `NEEDS_REVIEW` · `READY` · `ERROR` |
| psdFileId / artworkFileId / previewFileId | String? | FK LibraryFile |
| fields | String | JSON, see below |
| fixedTexts | String | JSON: text layers that are not custom (name, text, font) |
| missingFonts | String | JSON: postscript names |
| warnings | String | JSON strings (warp, size mismatch, effects not supported…) |
| checkScore | Float? | mean abs diff (0–255) between our re-render of the sample text and the PSD composite, at 1/8 scale |
| error | String? | |
| parsedAt / approvedAt | DateTime? | |
| approvedById | String? | |
| notes | String? | |
| createdAt / updatedAt | | |

Unique `[storeId, shopifyProductId, printTemplateId]`.

`fields` entry: `{ field, layer, area?, sample, font (postscript), sizePx, color "#rrggbb", align left|center|right, box {x,y,w,h} (template px), anchor top|center|bottom, tracking, leading?, stroke? {px,color}, shadow? {dx,dy,blur,color,opacity}, fit shrink|wrap|none, maxChars? }`. The parser fills everything except `fit`/`maxChars` (defaults `shrink`/none). The UI edits `field`, `fit`, `maxChars` and `box`.

`DesignFont`: `id`, `postscriptName` unique, `family`, `style`, `fileId` (FK LibraryFile kind FONT), `uploadedById`, `createdAt`.

`ArtworkJob`: `id`, `kind` (`PARSE_PSD`), `entryId` FK cascade, `status` (`QUEUED` · `RUNNING` · `DONE` · `FAILED`), `attempts`, `lockedAt`, `error`, `createdAt`, `finishedAt`. A RUNNING job whose `lockedAt` is older than 15 minutes is reclaimable.

## Which slots exist (the mapping view)

`listLibraryProducts({ q, status })` and `loadLibraryProduct(key)` in `src/lib/repos/artwork-library.ts`:

- Products = order lines of the last 90 days grouped by `(storeId, shopifyProductId)` (same source as Sản phẩm), plus products that already have entries.
- Each product groups its lines by the template the line resolves to now (`loadTemplateContext` / `templateForLine`: profile template for the same supplier → `SupplierProduct.printTemplateId` → legacy SKU match). A slot shows:
  - supplier name and supplier SKUs;
  - variant option values going to it (e.g. "20oz(No handle) · US, Overseas");
  - template name, px size, DPI, areas;
  - line count;
  - the entry, if one exists.
- Lines with a supplier but no template make a "Chưa có template" slot (supplier + SKU) linking to `/setup/suppliers/<id>/print-templates`. No upload is possible there.
- Lines with no supplier are counted as "Chưa mapping" and link to `/fulfillment/mapping`.
- Entries whose template no longer receives lines show under "Không còn dùng (vẫn hợp lệ)".
- Product status for the list: `READY` when every active slot has a READY entry; else the worst slot status (`NO_TEMPLATE` < `EMPTY` < `ERROR` < `NEEDS_FONTS` < `NEEDS_REVIEW` < `PARSING`/`QUEUED`).

## Upload

- `PUT /api/design-studio/library/entries/upload?storeId=&productId=&templateId=&fileName=`: raw body (no multipart), streamed to a temp file under `storageRoot()/tmp`. It is never buffered whole.
  - Cap 1 GB; checks the `.psd` extension and the `8BPS` magic bytes.
  - Upserts the entry, stores the PSD as a `LibraryFile`, and pushes it to Drive when connected (generalise the chunked push to any `LibraryFile`). Folder: `Design Studio/Library/<Store>/<product title>/<Supplier> - <Template>`. The file is not shared publicly.
  - Then sets `status QUEUED`, clears the previous parse results (the old files are kept), and creates a `PARSE_PSD` job.
- `PUT /api/design-studio/library/fonts/upload?fileName=`: `.ttf`/`.otf`/`.ttc`, ≤ 30 MB.
  - Reads the postscript name, family and style from the font's `name` table, using a small parser in `src/lib/font-name.ts` with no dependency.
  - Upserts `DesignFont` by postscript name, with Drive folder `Design Studio/Fonts`.
  - Then requeues every entry in `NEEDS_FONTS` whose `missingFonts` includes the name.
- `GET /api/design-studio/library/files/[id]`: serves PNG/fonts like the artwork file route (LOCAL stream, DRIVE stream, nosniff). PSD redirects to `driveWebViewLink` or is downloaded as an attachment.
- `PATCH /api/design-studio/library/entries/[id]`:
  - edits `fields` (validated shape) and `notes`;
  - `{ approve: true }` turns `NEEDS_REVIEW` into `READY`, setting `approvedAt` and `approvedById`;
  - `{ reparse: true }` requeues the job.
- `DELETE` an entry: admin only.

Access: covered by the existing `/api/design-studio` rule (design_tasks…). Uploads use `getAuthUser` for `uploadedById`.

## Parse worker (runs on the local PC)

`tools/artwork-worker/worker.py` (Python 3, `psd_tools`, `Pillow`, `numpy`, `fontTools`), `requirements.txt`, README.

- Config: env `ECOM_URL` (prod or `http://localhost:3002`) and `DESIGN_WORKER_TOKEN`. Run once with `--once` or loop with `--poll 10`.
- Machine API under `/api/design-studio/worker/*`:
  - It is a `PUBLIC` rule placed before `/api/design-studio`. Every route checks `Authorization: Bearer <token>` against AppSetting `design.worker.tokenHash` (sha256, timing-safe).
  - The token is generated (shown once) and revoked in Design Studio Settings by SUPERADMIN.
  - Routes:
    - `POST worker/claim`: returns the oldest QUEUED or reclaimable job, plus the entry, template (size, DPI, areas) and the PSD file id. Sets the job RUNNING and the entry PARSING.
    - `GET worker/files/[id]`: downloads a PSD or font.
    - `GET worker/fonts`: lists `{postscriptName, fileId, sha256}`.
    - `POST worker/jobs/[id]/result`: multipart with `artwork.png`, `preview.png` and `result.json`. It stores the files and fields and sets the entry status.
    - `POST worker/jobs/[id]/fail`: records `{ error }`; after 3 attempts the job is FAILED and the entry ERROR.
- Parse steps:
  1. Open the PSD. Warn if its size ≠ the template px size; an aspect-ratio mismatch above 1% is an error.
  2. Collect type layers. Custom = layer name starts with `@` (field = the rest, trimmed). Other visible type layers go to `fixedTexts`.
  3. For each custom layer read:
     - font postscript name, size × transform scale → px;
     - fill colour, justification, tracking, leading;
     - bbox → box;
     - stroke / drop shadow from effects;
     - warp → warning.
  4. `artwork.png` = composite with custom layers hidden. `preview.png` = the PSD composite (or the embedded composite), downscaled to ≤ 2000 px.
  5. Fonts: download library fonts (cached under `~/.artwork-worker/fonts/<sha256>`). Missing ones → `missingFonts`, status `NEEDS_FONTS` (artwork and fields still uploaded).
  6. Check: draw each field's `sample` with Pillow on `artwork.png` using the extracted style, compare to the composite at 1/8 scale over the union of field boxes.
     - `checkScore` ≤ 6 and no warnings → READY.
     - Otherwise NEEDS_REVIEW, and the UI shows our render next to the PSD composite.
- The text-drawing code lives in `tools/artwork-worker/textrender.py` so the order-render step (next spec) reuses it.

## UI

- Sidebar, Design Studio group: "Artwork Library" (`/design-studio/library`, icon `photo_library`) after "Sản phẩm", plus a "Fonts" page (`/design-studio/library/fonts`). `FEATURE_PATHS.design_tasks` already covers `/design-studio`.
- **List:** product rows (image, title, store, slot chips "PGprints · Tumbler 20oz ✓", "Mangoshao · C450-30OZ — chưa có template"), open tasks, status; search; status filter; sorted by open tasks.
- **Product page** (`/design-studio/library/[key]`): one card per slot.
  - Header: supplier · template · size/DPI · variants.
  - Template guide thumbnail.
  - Drop zone "Upload PSD" with a progress bar (XHR upload progress) and the quy ước line "Layer chữ custom đặt tên `@Tên trường` (vd `@Custom Name`)".
  - After parse:
    - preview vs artwork (toggle) on the template canvas with the field boxes drawn;
    - fields table (field · layer · font · size · màu · căn · fit · max ký tự);
    - missing fonts with an upload button;
    - warnings and check score;
    - "Xác nhận dùng" for NEEDS_REVIEW;
    - "Đọc lại PSD";
    - download PSD.
  - The status polls every 5 s while QUEUED/PARSING.
  - Field names that don't match the product's observed customer fields show a warning ("Khách không có trường này"). Observed fields with no layer show "Thiếu layer @…".
- **Fonts page:** table (postscript, family, style, size, used by N entries), multi-file upload.
- **Task workspace:** the header shows "Artwork Library: Sẵn sàng / Thiếu / Đang đọc" for the line's template, linking to the product page.

## Tests

- `font-name` parses a TTF fixture.
- `listLibraryProducts` groups one product into two slots by template and supplier; no-template and no-supplier slots; a stale entry under "không còn dùng".
- Upload route: streams to disk, rejects a non-PSD and an oversize file, queues a job, re-upload resets the results.
- Worker auth: no / wrong token → 401, revoked token → 401.
- Claim is atomic: two claims never return the same job; a stale RUNNING job is reclaimed.
- Result stores files and sets READY / NEEDS_FONTS / NEEDS_REVIEW.
- Font upload requeues NEEDS_FONTS entries.
- Python: `pytest` for the layer → field extraction on a generated PSD fixture, if psd_tools can write one; otherwise on a small checked-in PSD.

## Deploy notes

- Migration + `SCHEMA_VERSION` bump.
- Nginx `client_max_body_size 1g` and a long `proxy_read_timeout` for `/api/design-studio/library/`.
- Generate the worker token on prod and run the worker on this PC.
