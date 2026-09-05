# Auto Fulfilled — push supplier tracking from Google Sheets to Shopify

- **Date:** 2026-09-05
- **Status:** Design — awaiting review before implementation plan
- **Area:** Fulfillment / Tracking
- **Related:** `src/lib/tracking/push-lastmile.ts` (updates tracking on *existing* fulfillments — different from this), `src/lib/tracking/build-shipments.ts` (lineKey convention), `src/lib/tracking/ndjson-stream.ts` (progress streaming), `src/lib/shopify-orders.ts` (GraphQL client)

## Problem

Suppliers maintain per-supplier Google Sheets and add new tracking numbers for orders daily (two columns: `Order Number`, `Tracking`). Those trackings must be pushed to Shopify by **creating fulfillments** on the still-unfulfilled orders — which marks the order Fulfilled and emails the customer a tracking link.

The existing `pushLastMileToShopify` only *updates tracking on fulfillments that already exist*; it reports `not_found` for unfulfilled orders. Auto Fulfilled fills the gap: it **creates** the fulfillment from the sheet's tracking.

## Decisions (resolved with the user)

| Topic | Decision |
|---|---|
| Sheet source | Paste the normal Google Sheets link. Sheet must be shared **"Anyone with the link → Viewer"**. App extracts `spreadsheetId + gid` and fetches the CSV export — no Google credentials, works headless on the VPS cron. |
| Multiple suppliers | Yes — a list of pasted sheet links, each with a supplier name + enable toggle. |
| Trigger | **Both**: manual Preview + Apply on a page, and a daily cron that applies enabled sheets. |
| Notify customer | **Yes** — `notifyCustomer: true` on fulfillment creation. |
| Split shipments | **Per-line** partial fulfillment: sub-orders with different trackings each fulfill their own line. |
| Line mapping | Sheet sub-order suffix `_N` follows the tool's **lineKey convention** (`<orderNo>_<n>`). Map via the existing `Shipment` table (`lineKey → shopifyLineId`), which the tracking sync already maintains. |
| Tracking link | Store-branded ParcelPanel page: `company: 'Other'`, `url: <storeBase>/apps/trackingorder?nums=<tracking>` with `storeBase` default `https://litzzy.com`. |
| Minimum order age | Only fulfill orders placed **≥ N days ago** (`Order.placedAt`), default **5 days**, configurable. An order younger than N days is **held** (`too_recent`) even if it already has a tracking; the daily cron fulfills it automatically once it ages past the threshold. |

## Sheet format (observed)

- Header row: `Order Number,Tracking`.
- Order tokens: `#LIT2225`; variants seen — sub-order suffix `_1`/`_2` (often several rows per order), occasionally missing `#`, revision suffix like `#LIT2362R1` / `#LIT2736R`, nested `_2_1`.
- Sub-orders of one order **usually share one tracking** (ship together → one fulfillment) but **sometimes differ** (split).
- Duplicate rows occur; ~600+ rows per sheet.

## Architecture & data flow

```
enabled sheets (AppSetting JSON)
  └─ for each sheet: fetch CSV export ──> parseSheetCsv() -> Row[]
       └─ groupByOrder() -> Map<baseOrderName, Row[]>
            └─ for each order (batched):
                 ├─ DB: Shipment rows for order  -> lineKey → shopifyLineId ; Order.placedAt
                 ├─ Shopify: fulfillmentOrders{ status, lineItems{ id, remainingQuantity, lineItem{ id, sku } } } + displayFulfillmentStatus + createdAt
                 └─ buildFulfillmentPlan(rows, shipmentMap, fulfillmentOrders, placedAt, now, minAgeDays) -> OrderPlan
                      status ∈ will_fulfill | too_recent | already_fulfilled | not_found | needs_manual | error
       Preview -> return plans (no writes)
       Apply   -> for each planned fulfillment: fulfillmentCreate(trackingInfo, notify) ; collect results
```

Progress is streamed as NDJSON (reuse `splitNdjson` + the ParcelPanel route pattern): `{type:"progress",done,total}` per order, then `{type:"done", summary, rows}`.

## Components (units)

### 1. Sheet config store — `src/lib/fulfillment/auto-fulfill-sheets.ts`
- Stored in `AppSetting` key `auto_fulfill_sheets` as JSON: `Array<{ id, name, url, enabled, storeBase }>`. **No migration.**
- Global setting `AppSetting` key `auto_fulfill_min_age_days` (default `5`) — the minimum order age gate.
- `getSheets()`, `saveSheets(list)`, `getMinAgeDays()`, `setMinAgeDays(n)`, plus `parseSheetUrl(url) -> { spreadsheetId, gid } | null` (pure, tested).
- CSV export URL: `https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>`.

### 2. CSV fetch + parse — `src/lib/fulfillment/parse-sheet.ts` (pure, tested)
- `fetchSheetCsv(url)` — GET the export URL (Node follows the 307 redirect). Non-CSV / HTML (login page) → throw a clear "sheet chưa bật link-view" error.
- `parseSheetCsv(text) -> Array<{ orderToken, tracking }>`:
  - Split lines; detect header by matching a column containing `order` and one containing `track` (case-insensitive); else fall back to first column = order, last = tracking.
  - Skip header, blank rows, and rows with empty tracking.
  - Deduplicate identical `(orderToken, tracking)` pairs.

### 3. Order/line grouping + plan — `src/lib/fulfillment/build-fulfill-plan.ts` (pure, tested)
- `normalizeBaseOrder(token)` — reuse/extend `normalizeOrderName`: strip `#`, strip trailing `_N` (and nested `_N_M`) to get the base order name; keep the full token to recover the lineKey.
- `groupByOrder(rows) -> Map<base, Array<{ lineKey, tracking }>>` where `lineKey` = token without leading `#` (matches `Shipment.lineKey`).
- `buildFulfillmentPlan({ rows, shipmentMap, fulfillmentOrders, displayFulfillmentStatus, placedAt, now, minAgeDays }) -> OrderPlan`:
  - If order already fully fulfilled → `already_fulfilled`.
  - If Shopify order/fulfillmentOrders not found → `not_found`.
  - **Minimum age gate:** if `now - placedAt < minAgeDays × 86_400_000` ms → `too_recent` (do not fulfill; it will qualify on a later run). Order date = `Order.placedAt` from DB, fallback to Shopify `createdAt`. `now` is injected so the function stays pure/testable.
  - For each row: `lineKey → shopifyLineId` (via `shipmentMap`); find the open `fulfillmentOrderLineItem` whose `lineItem.id === shopifyLineId` and `remainingQuantity > 0`.
  - Rows **without** a suffix (single-line order, or a whole-order row) → apply that tracking to all remaining open FO line items.
  - Group matched FO line items **by tracking** → one `PlannedFulfillment { fulfillmentOrderId, lineItems:[{id, quantity}], trackingInfo }` per distinct tracking.
  - If any row cannot be mapped confidently (no Shipment row and product-line fallback is ambiguous, or line counts disagree) → `needs_manual` (do **not** fulfill that order).
- Fallback when Shipment rows are missing: derive product-line order from Shopify line items (filter `isNonProductLine`, sort by position) to reconstruct `_N`; if still ambiguous → `needs_manual`.

### 4. Shopify calls — add to `src/lib/shopify-orders.ts`
- `fetchOrderFulfillmentOrdersByNames(shop, token, names[]) -> Map<name, { orderId, displayFulfillmentStatus, fulfillmentOrders:[{ id, status, lineItems:[{ id, remainingQuantity, lineItemId, sku }] }] }>` — batched with `name:.. OR ..` (25/batch, like `fetchOrderLinePropsByNames`), throttled.
- `createFulfillment(shop, token, { fulfillmentOrderId, lineItems, trackingInfo, notifyCustomer }) -> { ok, fulfillmentId?, error? }` — mutation `fulfillmentCreateV2` (confirm exact name/shape against the 2024-10 schema via the Shopify MCP `graphql_schema` at implementation time). Returns `userErrors` as `error`.

### 5. Orchestrator — `src/lib/fulfillment/auto-fulfill.ts`
- `runAutoFulfill({ shop, accessToken, sheets, minAgeDays, apply, onProgress }) -> { ordersChecked, fulfilled, tooRecent, alreadyFulfilled, notFound, needsManual, errored, rows }`.
- Flow: for each enabled sheet → fetch+parse → group → batch-load Shopify fulfillment orders + DB shipment map → build plans → if `apply`, call `createFulfillment` per planned fulfillment (throttle ~300ms) and record per-row result. Preview returns plans without writing.
- **Shipment write-back:** on a successful `createFulfillment`, update the matching `Shipment` row(s) (`trackingNumber`, `trackingUrl`, `carrier`, `shopifyFulfillmentId`, `status`) so the tracking dashboard reflects it immediately and the **04:00 ParcelPanel sync picks up the new tracking the same night** without waiting for the next day's Shopify tracking sync.
- Dedup across sheets by base order (first wins), so overlapping sheets don't double-fulfill.

### 6. API routes
- `GET/POST /api/fulfillment/auto-fulfill/config` — read/save the sheet list **and** `minAgeDays` (mirrors the ParcelPanel config route).
- `POST /api/fulfillment/auto-fulfill/run?apply=0|1` — streams NDJSON progress + final rows. `apply=0` = preview (dry-run), `apply=1` = apply.

### 7. Cron — `src/lib/fulfillment/auto-fulfill-scheduler.ts`
- Daily `cron.schedule` at **03:30 Asia/Ho_Chi_Minh**, registered in `src/instrumentation.ts`. Runs `runAutoFulfill({ apply: true })` for enabled sheets, stores `last_auto_fulfill_result` (with `ranAt`) in `AppSetting`. Skips silently if no enabled sheets or no Shopify connection.
- **Placement is deliberate** in the nightly chain: `03:00` Shopify tracking sync (builds the `Shipment` lineKey↔shopifyLineId map this feature needs) → **`03:30` Auto Fulfill** (creates fulfillments, writes tracking back to `Shipment`) → `04:00` ParcelPanel sync (reads the freshly-written trackings and pulls their carrier status the same night).

### 8. UI — `src/app/fulfillment/auto-fulfill/page.tsx` (+ Sidebar entry)
- Sheet config: add/remove rows (name, URL, storeBase, enable), Save. A **Minimum order age (days)** input (default 5).
- **Preview** and **Apply now** buttons with an X/Y progress bar (reuse the streaming client pattern from the Tracking page).
- Result table per order: order, sub-orders, tracking(s), lines to fulfill, status badge (incl. `too_recent` with the order's age). Summary counters. Last-run info.

## Idempotency & safety

- Only fulfill FO line items with `remainingQuantity > 0` → re-running skips already-fulfilled lines; Shopify is the source of truth (no local "processed" flag needed).
- `needs_manual` instead of guessing when mapping is uncertain.
- Preview-first is the default UX for the first run per sheet; cron applies directly but logs every row.
- Throttle Shopify calls; per-row errors don't abort the batch (collected in `rows`).
- Sheet must be link-viewable; a private sheet yields a clear error, not a silent skip.

## Testing

- **Unit (pure, TDD):** `parseSheetUrl` (edit URL, `#gid=` fragment, `?gid=`, no gid → 0); `parseSheetCsv` (header variants, `#`, `_N`, blanks, dupes, empty tracking); `normalizeBaseOrder` (`_N`, `_N_M`, `R`/`R1`); `buildFulfillmentPlan` (single-line, whole-order one tracking, split multi-tracking, already-fulfilled, missing shipment→fallback→needs_manual, line-count mismatch→needs_manual, **age gate: exactly 5 days → will_fulfill, 4 days → too_recent**).
- **Live:** Preview on the real store first; verify counts and a couple of orders before Apply.

## Out of scope (v1)

- Google service-account / private-sheet auth (only link-view sheets).
- Editing sheet contents; per-order manual overrides in the UI beyond re-run.
- Historical audit table (Shopify + `last_auto_fulfill_result` suffice for now).

## Resolved policy

- Cron runs at **03:30 Asia/Ho_Chi_Minh** (between the 03:00 Shopify tracking sync and the 04:00 ParcelPanel sync), so ParcelPanel picks up new trackings the same night.
- Cron **auto-applies (`apply: true`) from day one** — it creates fulfillments and emails customers. (The manual Preview button remains available for ad-hoc dry runs.) Safety rests on: the 5-day minimum-age gate, `needs_manual` on uncertain mapping, and only fulfilling still-open fulfillment-order lines.
