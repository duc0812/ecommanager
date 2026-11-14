# Dropship products — no design task, own tab in Design Studio

Date: 2026-11-14 · Branch: `feat/dropship-tab` (cut from `origin/main` 352ce40 = prod)

## Why

Some products are bought ready-made from a supplier (dropship): no print file, no mockup, only a supplier mapping and
then a send (CSV export like POD lines). Today every product line with a supplier becomes a design task and every send
gate asks for an approved design file, so these lines:

- clutter the designer queue (11 Christmas Grump robe lines on Reminiso are open MANUAL tasks; 6 are stuck REJECTED
  "Đơn đã fulfilled nhưng dòng chưa có file" because the robe was fulfilled outside the tool),
- can never reach "Chờ gửi xưởng" (it needs a DONE task + `designDriveLink` + mockup).

Products named by the owner as dropship so far: **Christmas Grump (Heated) Hooded Robe – Sherpa Lined**,
**The Grumpy Bum Tissue Holder** (both Reminiso). The owner names products/SKUs; we mark them.

## Goals

- Mark a Shopify product as dropship once; every line of it (old open lines and new orders) skips design.
- Dropship lines never create a design task; open tasks on them are cancelled with an event
  `Dropship — không cần design`.
- No send gate asks a dropship line for a print file, design link, approved task or mockup.
- A **Dropship** tab in Design Studio lists dropship lines not yet sent, in two groups:
  "Chưa map xưởng" (map it right there) and "Đã map — chờ gửi" (link to the Chờ gửi xưởng tab).
- Sending stays in the existing Chờ gửi xưởng tab (one place to send; mixed POD + dropship orders send together).
- Dropship lines go out by **CSV export** or by **Bondre API** (owner: some dropship products are sent to Bondre by API).

## Non-goals

- API push of dropship lines to Merchize / Printway / PGprints / Mango: refused with
  `Dropship — gửi bằng CSV hoặc Bondre` (no blank order at a POD supplier).
- Creating the dropship supplier and its SKUs/costs — the owner does that in Setup → Suppliers (none exists yet).
- Changing `SupplierProduct.requiresDesign` (stays unused).

## Anti-goals

- A POD line silently treated as dropship (a product is dropship only when explicitly flagged).
- A dropship order that disappears from every tab (it must be visible in Dropship until sent, then in Đã gửi).

## Approaches considered

- **A — flag on the Shopify product (chosen by owner).** `ProductProfile.dropship` is the source of truth, copied
  to `OrderLine.dropship` so Prisma filters can use it (OrderLine has no relation to ProductProfile).
- B — reuse `SupplierProduct.requiresDesign`: every existing SKU is `false`, so turning it on means re-flagging all
  POD SKUs; and it is per supplier SKU, not per store product. Rejected.
- C — a product-id list in `AppSetting`: no schema change but Prisma `where` filters can't use it, every gate would
  filter in code. Rejected.

## Design

### Data

- `ProductProfile.dropship Boolean @default(false)` — source of truth, per (storeId, shopifyProductId).
- `OrderLine.dropship Boolean @default(false)` + index — denormalised copy.
- Copy rule: order sync (`shopify-order-sync.ts`, where lines are created/updated) sets `line.dropship` from the
  profile of (order.storeId, line.shopifyProductId). Toggling the flag rewrites `dropship` on every line of that
  product whose order is not closed/shipped, then runs `syncDesignTasksCounted` + status recompute for those orders.
- Migration via `migrate diff` SQL (migrate dev is silent on this PC), bump `SCHEMA_VERSION`.

### Gates that skip dropship lines (from the origin/main read)

| Where | Change |
|---|---|
| `design-tasks.ts` `syncDesignTasks` | dropship line: no create; existing task not DONE/CANCELLED → CANCELLED + event |
| `line-export.ts` `isDesignOpen` / `lineHold` | dropship line is never design-open |
| `pipeline-status` inputs (`shopify-order-sync.ts`, `design-reeval.ts`, `order-costs.ts`, `mapping.ts`) | `hasDesignLine` ignores dropship lines → an all-dropship mapped order goes READY_TO_PRODUCTION |
| `design-studio.ts` `designReady` | dropship lines don't need `designDriveLink` |
| `supplier-handoff.ts` `pendingHandoffWhere` | `designTasks some DONE` OR `lines some dropship` |
| `handoff-hub.ts` warnings | no `NO_MOCKUP` for dropship lines |
| `fulfillment/export` route + `export-design-links.ts` | dropship line: no open-task skip, no link columns, no "design chưa được duyệt" |
| `push-export.ts` `planPushLines` | dropship line counts as approved (no task/link needed) |
| `bondre-push.ts` `buildBondrePush` | dropship line: no `NOT_APPROVED`, no `collectLineFiles`; `design1..4 = ''`; `mockup1` = the line's Shopify image (`OrderLine.imageUrl`, https) — error `NO_MOCKUP` only if that is missing. API SKU / ship class / ship country checks unchanged |
| `merchize-push.ts`, `printway-push.ts`, `pgprints-push.ts` (and any other push builder) | dropship line → error `Dropship — gửi bằng CSV hoặc Bondre` |

Bondre check: before the first real dropship push, run the Bondre **preview** (server-side quote, cleared right
after, no order created) on one dropship order to confirm Bondre accepts an item with no design file. If Bondre
rejects it, report the message to the owner before changing anything.

### Dropship tab

- Page: new mode `'dropship'` in `src/app/design-studio/page.tsx` with a count chip like Chờ duyệt / Chờ gửi xưởng;
  component `components/DropshipGrid.tsx`.
- API: `GET /api/design-studio/dropship?q=` → open dropship lines (`exportedAt` null, order not closed/shipped):
  order number, store, placed date (MM/DD/YYYY), product, variant, qty, Shopify SKU, supplier name + supplier SKU or
  null. Grouped "Chưa map xưởng" / "Đã map — chờ gửi". Access rule in `API_ACCESS_RULES`: same as the handoff route.
- Map inline: supplier select + supplier SKU picker → existing `POST /api/fulfillment/mapping/manual`
  (`shopifyVariantId`, `shopifyProductTitle`, `variantTitle`, `supplierProductId`), which already re-resolves lines
  and recomputes status.
- "Đã map — chờ gửi" rows link to the Chờ gửi xưởng tab filtered by the order number.

### Marking products

- Toggle "Dropship — không cần design" on `/design-studio/products/[key]` (saved through `saveProfile`; creates the
  profile if missing). Leader/SUPERADMIN only.
- After deploy: flag the robe (every Shopify product id behind both titles) and the tissue holder, then check the
  5 open robe orders + REMI1126 sit in Dropship → Chưa map xưởng and the robe tasks are cancelled.

### Tests (test.db)

- sync: dropship line creates no task; open task → CANCELLED with the event; POD sibling unaffected.
- lineHold / handoff: mapped dropship-only order appears in pending handoff without any task or file; no NO_MOCKUP.
- CSV export: dropship line exports with empty link columns, no problem raised.
- Bondre build: dropship line → item with empty designs and `mockup1` = line image, no NOT_APPROVED / NO_ARTWORK;
  missing image → NO_MOCKUP. Mixed order (POD + dropship Bondre lines) still checks files on the POD line.
- Merchize/Printway/PGprints build: dropship line refused with the CSV/Bondre message.
- toggle: flipping the profile rewrites open lines and cancels their tasks; closed orders untouched.

## Left to the builder

- Exact placement of the copy in order sync and which status-recompute helper to call after a toggle.
- Supplier SKU picker UI (search box over that supplier's `SupplierProduct`s is enough).
