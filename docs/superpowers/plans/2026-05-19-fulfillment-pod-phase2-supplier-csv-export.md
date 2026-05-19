# Fulfillment & POD — Phase 2: Supplier Setup + CSV Export Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Ship the missing piece for end-to-end fulfillment: supplier setup UI + SKU price mapping + CSV template builder + CSV export. After this, user can register a supplier (Printful etc.), import SKU price list, build a CSV template, and export orders for daily fulfillment.

**Spec reference:** [`docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md`](../specs/2026-05-19-fulfillment-pod-design.md) Sections 7, 8.

**Prerequisite:** Plan 1 is shipped. Models `Supplier`, `SupplierProduct`, `CsvTemplate`, repos exist.

**Scope OUT of Plan 2 (defer to later):**
- Printful / Printify API connectors (cost auto-sync). For v1, user manually enters prices or imports CSV.
- Seed default templates programmatically (user creates templates via UI in Plan 2).
- Per-supplier-default product mapping selection on order line UI (covered in Plan 3 alert panel).

---

## File Structure

### New files
| Path | Responsibility |
|---|---|
| `src/app/api/suppliers/route.ts` | `GET` list + `POST` create supplier |
| `src/app/api/suppliers/[id]/route.ts` | `GET` one + `PATCH` update + `DELETE` (soft via isActive=false) |
| `src/app/api/suppliers/products/route.ts` | `GET` list (filterable) + `POST` create + `PUT` bulk-upsert (CSV import) |
| `src/app/api/suppliers/products/[id]/route.ts` | `PATCH` update + `DELETE` mapping |
| `src/app/api/suppliers/templates/route.ts` | `GET` list (by supplierId) + `POST` create |
| `src/app/api/suppliers/templates/[id]/route.ts` | `GET` one + `PATCH` + `DELETE` |
| `src/app/api/fulfillment/export/route.ts` | `POST` — generate CSV from template + filter |
| `src/app/setup/suppliers/page.tsx` | Suppliers CRUD list |
| `src/app/setup/products/page.tsx` | SKU mapping table + CSV import |
| `src/app/setup/suppliers/[id]/templates/page.tsx` | CSV template builder UI |
| `src/app/orders/export/page.tsx` | Export center: pick supplier + template + date range → download CSV |
| `src/lib/repos/templates.ts` | Template CRUD repo |
| `src/lib/csv-parser.ts` | Parse CSV string → rows (for SKU import) |
| `tests/csv-parser.test.ts` | Unit test |

### Modified
| Path | Change |
|---|---|
| `src/lib/repos/suppliers.ts` | Add `createSupplier`, `updateSupplier`, `deactivateSupplier`, `listAllSuppliers`, product CRUD helpers, bulk-upsert with cost history side-effect |
| `src/components/Sidebar.tsx` | Add Setup → Suppliers, Setup → Products, Orders → Export |
| `NOTES.md`, `PLAN.md` | Mark Plan 2 done |

---

## Architecture / Conventions

- **Routes still go through repos** — no direct prisma in routes (except auth checks if any).
- **Cost history side-effect**: any time `SupplierProduct.baseCost` changes (update OR upsert with diff), create a `SupplierCostHistory` row inside the same transaction. Implement in `repos/suppliers.ts` only.
- **CSV import format**: header row required: `sku,baseCost,productName?,currency?`. Lines without sku skipped. Numeric parse with fallback to 0. Errors aggregated and returned with per-line index.
- **Template UI**: drag-drop columns deferred — use number-input "order index" for v1 (simpler, fewer deps).
- **Export route**: accepts `{ templateId, projectId?, dateFrom, dateTo, pipelineStatus? }`. Returns `Content-Type: text/csv; charset=utf-8`; filename suggestion in `Content-Disposition`.
- **Source field dropdown** (template builder): hardcoded list — `order.shopifyOrderNumber`, `order.customerName`, `order.customerEmail`, `order.shippingCountry`, `order.shippingState`, `order.placedAt`, `line.sku`, `line.qty`, `line.productTitle`, `line.variantTitle`, `literal:<value>`.

---

## Task List (high-level)

Each task includes: file creation, TS check, smoke test (curl or browser), commit. Refer to Plan 1 patterns for code style.

### P2-T1: `/api/suppliers` CRUD route (+ `[id]` route)
- `GET /api/suppliers` → list (default: active only; `?includeInactive=1` for all)
- `POST /api/suppliers` → create with body `{name, code, apiType?, firstItemShipFee, additionalItemShipFee, currency, preferenceRank?, note?}`
- `GET /api/suppliers/[id]`, `PATCH /api/suppliers/[id]`, `DELETE /api/suppliers/[id]` (soft delete = `isActive=false`)
- Add `createSupplier`, `updateSupplier`, `deactivateSupplier`, `listAllSuppliers` to `src/lib/repos/suppliers.ts`

### P2-T2: `/setup/suppliers` page
- Table: name, code, apiType, ship fees, currency, active, # products, # templates
- "Add Supplier" button → modal form (or inline form below table)
- Edit per row → inline edit OR modal
- Deactivate button (with confirm)
- Use existing Tailwind tokens

### P2-T3: `/api/suppliers/products` CRUD + CSV import
- `GET /api/suppliers/products?supplierId=X&search=Y` → paginated list
- `POST /api/suppliers/products` → create one mapping
- `PUT /api/suppliers/products` (bulk import) — body `{supplierId, rows: [{sku, baseCost, productName?, currency?}]}` → upsert all, return `{created, updated, errors}` with cost-history side-effect for changed prices
- `PATCH /api/suppliers/products/[id]`, `DELETE /api/suppliers/products/[id]`
- Add `listProducts`, `upsertProductMapping`, `bulkUpsertProducts` to `repos/suppliers.ts` (bulk version uses transaction + creates `SupplierCostHistory` rows when oldCost !== newCost)
- `src/lib/csv-parser.ts` — minimal CSV parser (header row + comma split + quote handling). Unit test with sample input incl. quoted commas.

### P2-T4: `/setup/products` page
- Filter bar: supplier dropdown, search box, show-unmapped toggle (lists Order line items whose `sku` doesn't match any SupplierProduct)
- Table: sku, productName, supplier, baseCost, currency, updatedAt, [edit]
- "Add mapping" button → form (sku, supplier, baseCost)
- "Import CSV" button → file picker → preview → confirm → POST to `/api/suppliers/products` PUT
- Inline edit baseCost (click cell → input → blur → PATCH)

### P2-T5: `/api/suppliers/templates` CRUD
- `GET /api/suppliers/templates?supplierId=X` → list templates
- `POST /api/suppliers/templates` → create `{supplierId, name, columns (JSON), rowMode, isDefault?}`
- `GET /api/suppliers/templates/[id]`, `PATCH`, `DELETE`
- Add `listTemplates`, `createTemplate`, `updateTemplate`, `deleteTemplate` to new `src/lib/repos/templates.ts`

### P2-T6: `/setup/suppliers/[id]/templates` page (template builder UI)
- Header: supplier name + back link
- List existing templates (table: name, rowMode, isDefault, [edit] [delete])
- "New template" button → opens editor below
- Editor (form):
  - Name input
  - rowMode radio (PER_LINE / PER_ORDER)
  - Columns: ordered list of `{header, source}`. UI: "Add column" button appends row; each row: header input, source dropdown (hardcoded list), delete button, ↑ ↓ reorder buttons (use simple index swap instead of drag-drop)
  - "Preview" pane shows 3 latest orders rendered through the template (call existing `renderCsv` via API or do it client-side)
  - isDefault checkbox
  - Save / Cancel
- Live preview: fetch 3 latest orders for the supplier (`?supplierId=`), render CSV client-side using a shared helper

### P2-T7: `/api/fulfillment/export` POST route
- Body: `{ templateId, projectId?, dateFrom?, dateTo?, pipelineStatus? }`
- Look up template, look up orders via `ordersWithComputedPL` filter, transform orders to `OrderForCsv` shape, call `renderCsv`
- Return CSV with `Content-Disposition: attachment; filename="<supplierCode>-<dateFrom>-to-<dateTo>.csv"`
- Optionally update `Order.exportedAt = now()` and `Order.exportedToSupplierId = supplierId` for orders in result (this is a write side-effect — make idempotent and add a flag `markExported` in body so user can preview without marking)

### P2-T8: `/orders/export` page
- Filter bar: project selector (reuse), date range (with VN/US toggle from `formatBothZones`), pipeline status, supplier (to pick template's supplier scope), template dropdown (loads after supplier picked)
- "Preview" button → opens modal/section with rendered table from API (preview-only mode = `markExported: false`)
- "Download CSV" button → POST with `markExported: true`, browser saves file
- Show count of orders to be exported + total estimated profit

### P2-T9: Sidebar + docs
- Sidebar adds:
  ```
  Setup
    └ Suppliers       /setup/suppliers
    └ Products        /setup/products
  Fulfillment (under Finance or new group)
    └ Orders & P/L    /orders                  (existing)
    └ CSV Export      /orders/export           (new)
  ```
- Update NOTES.md + PLAN.md to mark Plan 2 done

---

## Test strategy

- **Unit:** csv-parser (parse with quoted commas, escaped quotes, empty rows)
- **Manual smoke test** (Plan 1 + Plan 2 end-to-end):
  1. Create a supplier "Printful" with ship fees
  2. Import CSV of 10 SKU mappings
  3. Click "Sync Now" on /orders → see profit non-zero for mapped SKUs
  4. Create a CSV template for Printful (Order#, SKU, Qty, Recipient, Country)
  5. Go to /orders/export → pick date range → preview → download → open in Excel → format correct
  6. Check that exported orders have `Order.exportedAt` populated

---

## Resume notes for future sessions

If context runs out mid-Plan-2: resume by reading the latest git log, checking which tasks have files committed, and continuing the next task. Each task is self-contained with file paths + commit message in the relevant subagent prompt.
