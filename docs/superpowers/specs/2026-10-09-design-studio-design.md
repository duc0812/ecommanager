# Design Studio — order workspace for the design team

**Status:** approved in chat 2026-10-09, first cut runs local only.
**Replaces:** the Trello board as the place designers work; `/api/trello/sync` stays as a fallback path until the team has moved.

## Goal

A designer opens one page, sees every order that still needs a print file, clicks an order and gets everything about that order in one place: what the customer typed, which supplier prints it, the supplier's template, the master artwork, the preview the customer saw, and a slot to upload the finished artwork per print area. Marking every line done moves the order out of `PENDING_DESIGN` exactly the way the Trello sync does today.

Out of scope for this cut: auto-generated print files, assignment / KPI / reject loop, CS questions to the customer, Google Drive storage. Those come after the workspace runs on real orders.

## Pages

### `/design-studio` — orders needing design

- Client page, `Sidebar` + `main`, nav entry under **Fulfillment** labelled "Design Studio" (icon `palette`), placed before Design Library.
- Tabs: **Cần design** (`PENDING_DESIGN` + `DESIGN_REJECTED`) and **Đã xong 7 ngày** (orders whose `designReady` flipped to true in the last 7 days, via `Order.updatedAt`).
- Filters: store (project), supplier, order type (CUSTOM / NON_CUSTOM / DUAL / MIXED), search on order number / SKU.
- Columns: order number, store, placed at (US date), order type, line count, supplier(s), preview thumbnail (first line with `previewCdnUrl`), hours waiting (`now - placedAt`), pipeline status badge.
- Row click → `/design-studio/[orderId]`.
- Data: `GET /api/fulfillment/orders` as it exists, with `pipelineStatus` and the other filters. No new list endpoint.

### `/design-studio/[orderId]` — one order, one workspace

Header: order number, store, placed at, pipeline status, order type, links to the Shopify order and the Trello card when one exists, "Nạp lại từ Shopify" button.

One block per `OrderLine`, in `linePosition` order. Each block, top to bottom:

1. **Thông tin custom** — visible custom attributes as label/value rows with a copy button; `_design` rendered as the customer design link (`customerDesignLink`); `_customized_url` as a link; a "ký tự đặc biệt" badge when a value has non-ASCII characters. Non-custom lines show the variant options instead.
2. **Supplier & template** — supplier name, supplier SKU, `SupplierProduct.designTemplateUrl` (link, or "chưa có template" in warning colour), `SkuDesign.driveLink` as master artwork, and the Design Library match (`lineDesignStatus`).
3. **Mockup / preview** — `previewCdnUrl` image; print files the source app produced (`_print_files` entries and `_customall_print_file`) as image links with their print-area names.
4. **Artwork** — one upload slot per print area. Print areas come from `_print_files[].print_area` names when present, otherwise a single slot named "Artwork". Each slot lists its versions (newest first) with file name, size, uploader, time, and an open link. Drag-and-drop or file picker; accepts png, jpg, pdf, psd, zip.
5. **Ghi chú** — free text saved per line.
6. **Đánh dấu xong** — enabled when every slot has at least one file. Sets `OrderLine.designDriveLink` to the newest file URL of the first slot (same column the Trello sync writes), and when every line of the order is done sets `Order.designReady = true` and recomputes the pipeline status through `autoDetectStatus` so the order leaves `PENDING_DESIGN`. "Mở lại" clears the flags.

## Data changes

### Persist line-item properties

`OrderLine.customAttributesJson String?` — JSON array of `{key, value}` exactly as Shopify returns it. Written in `upsertOrderWithLines` during `/api/shopify/orders/sync`. Migration `add_order_line_custom_attributes`; bump `SCHEMA_VERSION` to `v55`.

Backfill for orders synced before this change: `POST /api/design-studio/orders/[id]/refresh` calls `fetchOrderLinePropsByNames` for that order and writes the column. The "Nạp lại từ Shopify" button uses it. Lines whose `customAttributesJson` is null show a hint pointing at that button.

### Artwork files

`DesignArtwork` table:

| column | type | note |
|---|---|---|
| id | cuid | |
| orderLineId | FK OrderLine, cascade | |
| printArea | String | slot name |
| version | Int | per line + printArea, starts at 1 |
| fileName | String | original name |
| storagePath | String | relative path under the storage root |
| size | Int | bytes |
| mimeType | String | |
| uploadedById | String? | current user id |
| createdAt | DateTime | |

Unique on `[orderLineId, printArea, version]`.

`OrderLine.designNote String?` for the per-line note.

### Storage

Local directory `storage/design/<orderNumber>/<linePosition>/<printArea>/v<version>-<fileName>`, root from `DESIGN_STORAGE_DIR` env (default `./storage`), gitignored. Served by `GET /api/design-studio/file/[artworkId]`, which checks the permission, resolves the path from the row, and streams it. Nothing is ever served from a client-supplied path.

## API

All under `/api/design-studio`, access rule `['fulfillment_design_library', 'fulfillment_orders']` added to `API_ACCESS_RULES`.

| method & path | does |
|---|---|
| `GET /orders/[id]` | order + lines, each line with parsed attributes, supplier, template url, master artwork, design status, print-area slots and artwork versions |
| `POST /orders/[id]/refresh` | fetch line properties from Shopify and store them |
| `POST /lines/[lineId]/artwork` | multipart upload: `printArea`, `file`; returns the new row |
| `PATCH /lines/[lineId]` | `{ note?, done?: boolean }` |
| `GET /file/[artworkId]` | stream the file |

Errors: `{ error }` with 400 / 403 / 404, as elsewhere.

## Server logic

`src/lib/design-studio.ts`:

- `loadWorkspace(orderId)` — joins Order, OrderLine, Supplier, SupplierProduct (on `resolvedSupplierId` + `resolvedSupplierSku`), SkuDesign (on `sku`), DesignArtwork; parses `customAttributesJson` with the existing helpers in `order-classify.ts` (`visibleCustomAttributes`, `customerDesignLink`, print-file parsing).
- `printAreasForLine(attrs)` — names from `_print_files`, else `['Artwork']`.
- `markLineDone(lineId, done)` — the flag logic above, reusing `autoDetectStatus` input the sync route builds.

## Tests

Vitest on `test.db`, fixtures created by each test:

- `printAreasForLine`: `_print_files` with two areas → two names; no attributes → `['Artwork']`.
- `loadWorkspace` returns template url and master artwork when the joins match, and nulls when they don't.
- `markLineDone` flips `designReady` only when every line is done, and the order leaves `PENDING_DESIGN`.
- upload route rejects a file type outside the allow-list and writes version 2 on a second upload to the same slot.

## Permissions

New routes reuse `fulfillment_design_library` / `fulfillment_orders`; no new feature key yet. The page itself is reachable by anyone who can open Design Library.
