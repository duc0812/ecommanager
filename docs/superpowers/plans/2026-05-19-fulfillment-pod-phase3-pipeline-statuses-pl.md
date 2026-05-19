# Fulfillment & POD — Phase 3: Pipeline Statuses, Auto-Detect, Project P&L

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace simple PENDING/EXPORTED/FULFILLED pipelineStatus enum with the full POD ops taxonomy (11 statuses), auto-detect status on sync based on financial state + SKU mapping + custom-product flag, rewrite `/orders` as tab-based list with search + filters + bulk actions, and integrate fulfillment profit into per-project P&L.

**Spec reference:** [`docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md`](../specs/2026-05-19-fulfillment-pod-design.md) Sections 10–11.

**Status taxonomy (final, agreed with user):**

| Status (DB enum value) | Display | Source | Manual transition? |
|---|---|---|---|
| `PENDING_DESIGN` | Pending Design | Auto: unmapped SKU OR `requiresDesign=true` line | Yes (→ PENDING after design done) |
| `PENDING` | Pending | Auto: all SKU mapped, no custom flag | Yes |
| `ON_HOLD` | On Hold | Manual | Yes |
| `EXPORTED` | Exported (kept from Plan 1) | Auto on CSV export | Yes (or via re-export) |
| `SUPPLIER_PROCESSING` | Supplier Processing | Manual | Yes |
| `IN_PRODUCTION` | In Production | Manual | Yes |
| `FULFILLED` | Fulfilled | Manual | Yes |
| `DESIGN_REJECTED` | Design Rejected | Manual | Yes |
| `ERROR` | Error | Manual | Yes |
| `CANCELLED` | Cancelled | **Auto** from Shopify `financialStatus = VOIDED \| CANCELLED` (or manual) | Limited |
| `REFUNDED` | Refunded | **Auto** from Shopify `financialStatus = REFUNDED \| PARTIALLY_REFUNDED` | No (state of truth) |

**Auto-status precedence (in sync route):**
```
1. financialStatus is REFUNDED/PARTIALLY_REFUNDED  → REFUNDED
2. financialStatus is VOIDED/CANCELLED             → CANCELLED
3. order has unmapped SKU OR any line requiresDesign → PENDING_DESIGN
4. else                                            → PENDING
```

**Important rule:** On re-sync, auto-statuses (CANCELLED/REFUNDED) **always override** manual status. PENDING_DESIGN/PENDING **never override** if the order already moved past those (i.e., user manually set EXPORTED, SUPPLIER_PROCESSING, etc.). This avoids losing manual progress when re-syncing.

---

## File Structure

### New files
| Path | Responsibility |
|---|---|
| `src/app/api/fulfillment/orders/[id]/status/route.ts` | PATCH single order status |
| `src/app/api/fulfillment/orders/bulk-status/route.ts` | POST bulk status update |
| `src/app/api/projects/[id]/pl/route.ts` | GET combined P&L per project |
| `src/lib/pipeline-status.ts` | Status enum constants + auto-detect helper + label/color map |
| `tests/pipeline-status.test.ts` | Unit test for auto-detect logic |

### Modified files
| Path | Change |
|---|---|
| `prisma/schema.prisma` | Add `SupplierProduct.requiresDesign Boolean @default(false)` + migration |
| `src/lib/db.ts` | Bump SCHEMA_VERSION v9 → v10 |
| `src/lib/repos/orders.ts` | Add `updateOrderStatus`, `bulkUpdateStatus`, `countByStatus`. Modify `upsertOrderWithLines` to accept `pipelineStatus`. |
| `src/lib/repos/reports.ts` | Add `combinedProjectPL` — fulfillment + ad spend + staff cost |
| `src/app/api/shopify/orders/sync/route.ts` | Use auto-detect rule; preserve manual statuses on re-sync |
| `src/app/orders/page.tsx` | Rewrite to tab-based list (11 tabs with counts), search bar, More Filters panel, status dropdown per row, bulk actions |
| `src/app/setup/products/page.tsx` | Add `requiresDesign` checkbox per row (inline toggle) |
| `src/lib/repos/suppliers.ts` | Update `upsertProductMapping` + `bulkUpsertProducts` to accept `requiresDesign` |

---

## Task List

### P3-T1: Schema migration — `SupplierProduct.requiresDesign`
- Edit `prisma/schema.prisma`: add `requiresDesign Boolean @default(false)` to `SupplierProduct` model
- `npx prisma migrate dev --name add_requires_design_flag`
- `npx prisma generate`
- Bump SCHEMA_VERSION to v10 in `src/lib/db.ts`
- Commit

### P3-T2: pipeline-status lib + auto-detect (TDD)
- Create `src/lib/pipeline-status.ts`:
  ```typescript
  export const PIPELINE_STATUSES = [
    'PENDING_DESIGN', 'PENDING', 'EXPORTED', 'ON_HOLD',
    'SUPPLIER_PROCESSING', 'IN_PRODUCTION', 'FULFILLED',
    'DESIGN_REJECTED', 'ERROR', 'CANCELLED', 'REFUNDED',
  ] as const
  export type PipelineStatus = typeof PIPELINE_STATUSES[number]
  
  export const STATUS_LABELS: Record<PipelineStatus, string> = {
    PENDING_DESIGN: 'Pending Design', PENDING: 'Pending', EXPORTED: 'Exported',
    ON_HOLD: 'On Hold', SUPPLIER_PROCESSING: 'Supplier Processing',
    IN_PRODUCTION: 'In Production', FULFILLED: 'Fulfilled',
    DESIGN_REJECTED: 'Design Rejected', ERROR: 'Error',
    CANCELLED: 'Cancelled', REFUNDED: 'Refunded',
  }
  
  /** Statuses set by sync (never overridden manually for these specifically) */
  export const TERMINAL_AUTO_STATUSES: PipelineStatus[] = ['CANCELLED', 'REFUNDED']
  
  /** Statuses sync re-evaluates only if order hasn't progressed past them */
  export const SYNC_INITIAL_STATUSES: PipelineStatus[] = ['PENDING_DESIGN', 'PENDING']
  
  export type AutoDetectInput = {
    financialStatus: string  // Shopify financialStatus
    hasUnmappedSku: boolean
    hasCustomDesignLine: boolean  // any line where SupplierProduct.requiresDesign = true
    currentStatus?: PipelineStatus | null  // existing status if order exists
  }
  
  export function autoDetectStatus(input: AutoDetectInput): PipelineStatus {
    const fs = (input.financialStatus || '').toUpperCase()
    if (fs.includes('REFUND')) return 'REFUNDED'
    if (fs === 'VOIDED' || fs === 'CANCELLED') return 'CANCELLED'
    // If user already manually moved past initial → preserve their status
    if (input.currentStatus && !SYNC_INITIAL_STATUSES.includes(input.currentStatus)
        && !TERMINAL_AUTO_STATUSES.includes(input.currentStatus)) {
      return input.currentStatus
    }
    if (input.hasUnmappedSku || input.hasCustomDesignLine) return 'PENDING_DESIGN'
    return 'PENDING'
  }
  ```
- Tests in `tests/pipeline-status.test.ts`:
  1. REFUNDED financial → REFUNDED status
  2. PARTIALLY_REFUNDED → REFUNDED
  3. VOIDED → CANCELLED
  4. Paid + unmapped SKU → PENDING_DESIGN
  5. Paid + custom design line → PENDING_DESIGN
  6. Paid + all mapped + no custom → PENDING
  7. Existing status = EXPORTED, paid, mapped → preserve EXPORTED (no override)
  8. Existing status = CANCELLED, paid → preserve CANCELLED only if auto says CANCELLED (always derived from financial)
- TDD: write tests first, run fail, impl, run pass, commit

### P3-T3: Sync route uses auto-detect
- Modify `src/app/api/shopify/orders/sync/route.ts`:
  - For each order, compute `hasUnmappedSku` from pl.hasUnmappedSku, `hasCustomDesignLine` from lines (look up SupplierProduct.requiresDesign via priceMap or extend buildSkuPriceMap to return this flag)
  - Read existing `Order.pipelineStatus` (if exists) to pass into autoDetectStatus
  - Pass result into `upsertOrderWithLines` (add `pipelineStatus` field there)
- Modify `src/lib/repos/orders.ts`:
  - Extend `UpsertOrderInput` with `pipelineStatus`
  - On create: use provided status (default PENDING)
  - On update: use provided status (overwrites)
- Modify `src/lib/repos/suppliers.ts` `buildSkuPriceMap` to include `requiresDesign` in the SupplierInput map (extend the type slightly OR return a separate map)
- Commit

### P3-T4: Status update APIs + repo
- Add to `src/lib/repos/orders.ts`:
  ```typescript
  export async function updateOrderStatus(orderId: string, status: PipelineStatus) { ... }
  export async function bulkUpdateOrderStatus(orderIds: string[], status: PipelineStatus) { ... }
  export async function countByStatus(filter: { projectId?: string }): Promise<Record<PipelineStatus, number>> { ... }
  ```
- Create `src/app/api/fulfillment/orders/[id]/status/route.ts` (PATCH)
- Create `src/app/api/fulfillment/orders/bulk-status/route.ts` (POST: `{ orderIds: string[], status: PipelineStatus }`)
- Validate status is in PIPELINE_STATUSES enum
- Commit

### P3-T5: requiresDesign UI in /setup/products
- Add column to products table: "Custom?" with checkbox
- Inline toggle: clicking checkbox calls PATCH `/api/suppliers/products/[id]` with `{ requiresDesign }`
- Update CSV import: parser also reads `requiresDesign` column (TRUE/FALSE/1/0); bulk-upsert respects it
- Update CSV import API and bulkUpsertProducts to handle requiresDesign
- Commit

### P3-T6: Rewrite /orders to tab-based list
This is the biggest task. Rewrite `src/app/orders/page.tsx`:
- Top: title "All Orders" + Sync button + Project selector
- Search bar: filter by orderNumber/customerName/customerEmail (server-side via API; debounced)
- "More filters" button → expands panel with: date range, supplier filter, hasUnmappedSku checkbox
- Tabs row: All (with total count), then 1 tab per status (with count badge if non-zero). Active tab highlighted.
- Stat cards row (keep from current `/orders`): Revenue / COGS / Profit / Margin / Orders (responds to active tab + filters)
- Orders table:
  - Checkbox column for multi-select
  - Order #, Customer, Date, Supplier, Payout, COGS, Profit, Margin, Status (dropdown to change)
  - Click row → expand to show line items + supplier + fulfillment timeline (compact)
- Bulk action bar (visible when ≥1 selected): "Change status to..." dropdown + Apply button
- API additions:
  - `/api/fulfillment/orders` accepts `pipelineStatus` (already does — Plan 1), add `search` param
  - Need new endpoint for status counts: `/api/fulfillment/status-counts?projectId=X` returns `{ PENDING_DESIGN: 12, PENDING: 8, ... }`
- Use `STATUS_LABELS` from pipeline-status.ts for display
- Commit

### P3-T7: Project P&L combined endpoint + /projects integration
- Add to `src/lib/repos/reports.ts`:
  ```typescript
  export type CombinedProjectPL = {
    projectId: string
    projectName: string
    fulfillmentRevenue: number
    fulfillmentCogs: number  // base + shipping
    fulfillmentProfit: number
    metaAdSpend: number      // Σ MetaBilling for project's MetaAdAccount linked
    staffCost: number        // Σ StaffAssignment.staff.monthlyCost × months active in range
    netProfit: number        // fulfillmentProfit − metaAdSpend − staffCost
    dateFrom: Date | null
    dateTo: Date | null
  }
  export async function combinedProjectPL(filter: { projectId: string; dateFrom?: Date; dateTo?: Date }): Promise<CombinedProjectPL>
  ```
- Create `/api/projects/[id]/pl/route.ts` GET
- Modify `/projects` page: add a "P&L (Combined)" card per project that calls the new endpoint
- Commit

### P3-T8: Docs update
- Update NOTES.md + PLAN.md to mark Plan 3 done
- Note any deferred items (Printful/Printify API connectors → still future)
- Commit

---

## Test strategy
- TDD on `pipeline-status.ts` (P3-T2): 8+ test cases
- Sync route: re-run integration test from Plan 1 to ensure no regression on pipelineStatus assignment
- Manual E2E smoke:
  1. Add SKU with `requiresDesign=true` in /setup/products
  2. Sync orders that contain that SKU → check those orders go to PENDING_DESIGN tab
  3. Sync order that's refunded in Shopify → check it appears in Refunded tab
  4. Bulk select 5 PENDING orders → change to ON_HOLD → tab counts update
  5. Open /projects → see fulfillment profit row + combined P&L

---

## Notes for resume
If context runs out: read this plan + latest git log + NOTES.md "Active Work" block. Each task self-contained; tasks 4–7 depend on T2 (pipeline-status lib) being done.
