# Manual Base Cost Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users manually edit the per-unit base cost on individual order lines; the manual value wins over the mapping-resolved cost everywhere and survives re-sync.

**Architecture:** New nullable column `OrderLine.manualBaseCost`. Effective cost = `manualBaseCost ?? resolvedBaseCost`, computed in `src/lib/order-profit.ts` (the single choke point for COGS/profit). A small PATCH API mutates the column; the order-detail modal on `/orders` gets an inline editor. Re-sync (`upsertOrderWithLines` delete+recreate) carries the column over unconditionally.

**Tech Stack:** Next.js 14 App Router, Prisma v7 + LibSQL (SQLite), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-manual-base-cost-design.md`

**Conventions (from CLAUDE.md):**
- Run all commands from `C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh`
- Never add `url` to `datasource db {}` in schema.prisma
- After schema change: `npx prisma migrate dev --name <name>` → `npx prisma generate` → bump `SCHEMA_VERSION` in `src/lib/db.ts`
- Note: `tests/shopify-orders-sync.integration.test.ts` has a PRE-EXISTING failure on local machines (empty local DB, missing ProductBase mapping). Ignore that one failure; everything else must pass.

---

### Task 1: Schema — add `manualBaseCost` column

**Files:**
- Modify: `prisma/schema.prisma` (model OrderLine, ~line 392)
- Modify: `src/lib/db.ts:6` (SCHEMA_VERSION)

- [ ] **Step 1: Add the column to the OrderLine model**

In `prisma/schema.prisma`, after the `resolvedBaseCost` line inside `model OrderLine`:

```prisma
  resolvedBaseCost        Float?
  manualBaseCost          Float?
```

- [ ] **Step 2: Run migration and regenerate client**

```bash
npx prisma migrate dev --name add_manual_base_cost
npx prisma generate
```

Expected: migration `..._add_manual_base_cost` created and applied, client generated without errors.

- [ ] **Step 3: Bump SCHEMA_VERSION**

In `src/lib/db.ts` line 6, change:

```typescript
const SCHEMA_VERSION = 'v23' // bump this to force singleton reset after schema changes
```

(was `'v22'`)

- [ ] **Step 4: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts
git commit -m "feat: add OrderLine.manualBaseCost column"
```

---

### Task 2: Effective cost in `order-profit.ts` (TDD)

**Files:**
- Modify: `src/lib/order-profit.ts`
- Test: `src/lib/order-profit.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/order-profit.test.ts` (inside the file, new describe block at the end):

```typescript
describe('manualBaseCost override', () => {
  it('uses manualBaseCost over resolvedBaseCost in cogs', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedSupplierId: 'sup1', resolvedBaseCost: 40, manualBaseCost: 25, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBeCloseTo(100 - 25 - 5, 2)
  })

  it('line with supplier and only a manual cost is not unmapped', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: 'sup1', resolvedBaseCost: null, manualBaseCost: 30, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: null },
    ])
    expect(result?.hasUnmapped).toBe(false)
    expect(result?.estimatedCogs).toBeCloseTo(30, 2)
  })

  it('manual cost without supplier mapping still counts as unmapped', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: null, manualBaseCost: 30, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: null },
    ])
    expect(result?.hasUnmapped).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/order-profit.test.ts`
Expected: FAIL — first test asserts 70 but gets 55 (manual ignored, 100−40−5); typecheck may also reject `manualBaseCost` property.

- [ ] **Step 3: Implement effective cost**

In `src/lib/order-profit.ts`:

Add `manualBaseCost` to the type (after `resolvedSupplierId`):

```typescript
export type OrderLineForProfit = {
  qty: number
  resolvedSupplierId?: string | null
  resolvedBaseCost: number | null
  manualBaseCost?: number | null
  resolvedShipFirst: number | null
  resolvedShipAdditional: number | null
  resolvedImportTax: number | null
}
```

Add an exported helper right below the type:

```typescript
export function effectiveBaseCost(line: Pick<OrderLineForProfit, 'manualBaseCost' | 'resolvedBaseCost'>): number | null {
  return line.manualBaseCost ?? line.resolvedBaseCost
}
```

In `computeKnownOrderCogs`, change the baseCost reduce line to:

```typescript
  const baseCost = lines.reduce((s, l) => s + (effectiveBaseCost(l) ?? 0) * l.qty, 0)
```

In `hasUnmappedProductCost`, change the body to:

```typescript
export function hasUnmappedProductCost(lines: OrderLineForProfit[]): boolean {
  return lines.some(l => !l.resolvedSupplierId || effectiveBaseCost(l) === null)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/order-profit.test.ts`
Expected: all tests PASS (existing tests included — they omit `manualBaseCost`, which is optional, so `effectiveBaseCost` falls back to `resolvedBaseCost`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/order-profit.ts src/lib/order-profit.test.ts
git commit -m "feat: manualBaseCost wins over resolvedBaseCost in profit calc"
```

---

### Task 3: Re-sync carries `manualBaseCost` over (TDD)

**Files:**
- Modify: `src/lib/repos/orders.ts` (`upsertOrderWithLines`, ~lines 139–250)
- Test: Create `tests/manual-base-cost.integration.test.ts`

Background: `upsertOrderWithLines` deletes all lines and recreates them on every sync, copying snapshot fields from the old rows. `manualBaseCost` must be copied **unconditionally** (even when the supplier mapping changed) — the user's entered price is the user's truth until they clear it.

- [ ] **Step 1: Write the failing test**

Create `tests/manual-base-cost.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { upsertOrderWithLines } from '@/lib/repos/orders'

const ORDER_ID = 'gid://test/Order/mbc-1'
const SHOP = 'mbc-test.myshopify.com'

function orderInput(storeId: string, supplierId = 'sup_mbc_x') {
  return {
    id: ORDER_ID,
    projectId: 'proj_mbc',
    storeId,
    shopifyOrderNumber: '#MBC1',
    customerEmail: null,
    customerName: null,
    shippingCountry: null,
    shippingState: null,
    financialStatus: 'PAID',
    fulfillmentStatus: null,
    currency: 'USD',
    grossAmount: 100,
    expectedPayout: 95,
    totalFees: 5,
    refundedAmount: 0,
    defaultSupplierId: null,
    placedAt: new Date('2026-06-10T00:00:00Z'),
    lines: [{
      shopifyLineId: 'mbc-line-1',
      sku: 'MBC-SKU',
      variantTitle: null,
      productTitle: 'Test product',
      qty: 1,
      linePosition: 1,
      unitPrice: 100,
      resolvedSupplierId: supplierId,
      resolvedBaseCost: 40,
      resolvedShipFirst: 5,
      resolvedShipAdditional: 2,
      resolvedImportTax: 0,
    }],
  }
}

beforeAll(async () => {
  await prisma.project.upsert({
    where: { id: 'proj_mbc' },
    create: { id: 'proj_mbc', name: 'MBC Test', startDate: new Date('2026-06-01') },
    update: { archivedAt: null },
  })
  await prisma.shopifyStore.upsert({
    where: { shop: SHOP },
    create: { shop: SHOP, projectId: 'proj_mbc' },
    update: { projectId: 'proj_mbc' },
  })
})

afterAll(async () => {
  await prisma.orderLine.deleteMany({ where: { orderId: ORDER_ID } })
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
})

describe('upsertOrderWithLines manualBaseCost carry-over', () => {
  it('preserves manualBaseCost when lines are recreated on re-sync', async () => {
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })
    await upsertOrderWithLines(orderInput(store.id))
    const created = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    await prisma.orderLine.update({ where: { id: created.id }, data: { manualBaseCost: 12.5 } })

    await upsertOrderWithLines(orderInput(store.id))
    const afterResync = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(afterResync.manualBaseCost).toBe(12.5)
  })

  it('preserves manualBaseCost even when the supplier mapping changed', async () => {
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })
    await upsertOrderWithLines(orderInput(store.id, 'sup_mbc_y'))
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(line.manualBaseCost).toBe(12.5)
    expect(line.resolvedSupplierId).toBe('sup_mbc_y')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/manual-base-cost.integration.test.ts`
Expected: FAIL — `afterResync.manualBaseCost` is `null` (column not carried over yet).

- [ ] **Step 3: Carry the column in `upsertOrderWithLines`**

In `src/lib/repos/orders.ts`:

(a) Add `manualBaseCost: true` to the `existingLines` select (after `resolvedBaseCost: true`, ~line 145):

```typescript
      resolvedBaseCost: true,
      manualBaseCost: true,
      costSnapshotAt: true,
```

(b) In the `createMany` data mapper (~line 238), after the `resolvedBaseCost` line add:

```typescript
          resolvedBaseCost: preserveSnapshot ? snap.resolvedBaseCost : l.resolvedBaseCost,
          manualBaseCost: snap?.manualBaseCost ?? null,
```

(Unconditional — NOT gated on `preserveSnapshot`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/manual-base-cost.integration.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/repos/orders.ts tests/manual-base-cost.integration.test.ts
git commit -m "feat: manualBaseCost survives order line recreation on re-sync"
```

---

### Task 4: PATCH API route (TDD)

**Files:**
- Create: `src/app/api/fulfillment/orders/line-cost/route.ts`
- Test: Modify `tests/manual-base-cost.integration.test.ts` (append)

Note: the path follows the existing `/api/fulfillment/orders/...` family used by the Orders page (the spec's `/api/orders/line-cost` is adjusted to match codebase conventions).

- [ ] **Step 1: Write the failing tests**

Append to `tests/manual-base-cost.integration.test.ts`:

```typescript
import { PATCH } from '@/app/api/fulfillment/orders/line-cost/route'

function patchReq(body: unknown) {
  return new Request('http://test/api/fulfillment/orders/line-cost', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/fulfillment/orders/line-cost', () => {
  it('sets manualBaseCost on a mapped line', async () => {
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    const res = await PATCH(patchReq({ lineId: line.id, manualBaseCost: 19.99 }) as any)
    expect(res.status).toBe(200)
    const saved = await prisma.orderLine.findUniqueOrThrow({ where: { id: line.id } })
    expect(saved.manualBaseCost).toBeCloseTo(19.99, 2)
  })

  it('clears manualBaseCost with null (revert to auto)', async () => {
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    const res = await PATCH(patchReq({ lineId: line.id, manualBaseCost: null }) as any)
    expect(res.status).toBe(200)
    const saved = await prisma.orderLine.findUniqueOrThrow({ where: { id: line.id } })
    expect(saved.manualBaseCost).toBeNull()
  })

  it('rejects manual cost on a line without supplier mapping', async () => {
    const unmapped = await prisma.orderLine.create({
      data: {
        orderId: ORDER_ID,
        shopifyLineId: 'mbc-line-unmapped',
        sku: 'MBC-UNMAPPED',
        productTitle: 'Unmapped product',
        qty: 1,
        linePosition: 2,
        unitPrice: 50,
        resolvedSupplierId: null,
        resolvedBaseCost: null,
      },
    })
    const res = await PATCH(patchReq({ lineId: unmapped.id, manualBaseCost: 10 }) as any)
    expect(res.status).toBe(400)
  })

  it('rejects negative and non-numeric values', async () => {
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect((await PATCH(patchReq({ lineId: line.id, manualBaseCost: -1 }) as any)).status).toBe(400)
    expect((await PATCH(patchReq({ lineId: line.id, manualBaseCost: 'abc' }) as any)).status).toBe(400)
  })

  it('404s for unknown line', async () => {
    const res = await PATCH(patchReq({ lineId: 'nope', manualBaseCost: 5 }) as any)
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manual-base-cost.integration.test.ts`
Expected: FAIL — module `@/app/api/fulfillment/orders/line-cost/route` not found.

- [ ] **Step 3: Implement the route**

Create `src/app/api/fulfillment/orders/line-cost/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body.lineId !== 'string') {
    return NextResponse.json({ error: 'lineId required' }, { status: 400 })
  }
  const value = body.manualBaseCost
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    return NextResponse.json({ error: 'manualBaseCost must be a number >= 0 or null' }, { status: 400 })
  }

  const line = await prisma.orderLine.findUnique({
    where: { id: body.lineId },
    select: { id: true, resolvedSupplierId: true },
  })
  if (!line) return NextResponse.json({ error: 'Line not found' }, { status: 404 })
  if (value !== null && !line.resolvedSupplierId) {
    return NextResponse.json({ error: 'Line chưa được map supplier — map trước khi nhập giá manual' }, { status: 400 })
  }

  const updated = await prisma.orderLine.update({
    where: { id: line.id },
    data: { manualBaseCost: value },
  })
  return NextResponse.json({ line: updated })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/manual-base-cost.integration.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/fulfillment/orders/line-cost/route.ts tests/manual-base-cost.integration.test.ts
git commit -m "feat: PATCH line-cost API for manual base cost override"
```

---

### Task 5: Effective cost in CSV export and mapping count

**Files:**
- Modify: `src/app/api/fulfillment/export/route.ts` (~lines 111–112, `crogsPrice`/`crogsTotal`)
- Modify: `src/lib/repos/reports.ts` (~line 78, `mappedLineCount`)

- [ ] **Step 1: Use effective cost for CSV crogs columns**

In `src/app/api/fulfillment/export/route.ts`, add the import:

```typescript
import { effectiveBaseCost } from '@/lib/order-profit'
```

In the line mapper, replace:

```typescript
            crogsPrice: l.resolvedBaseCost,
            crogsTotal: l.resolvedBaseCost == null ? null : l.resolvedBaseCost * l.qty,
```

with:

```typescript
            crogsPrice: effectiveBaseCost(l),
            crogsTotal: effectiveBaseCost(l) == null ? null : effectiveBaseCost(l)! * l.qty,
```

- [ ] **Step 2: Use effective cost in mappedLineCount**

In `src/lib/repos/reports.ts`, add `effectiveBaseCost` to the existing import:

```typescript
import { estimateOrderCostAndProfit, effectiveBaseCost } from '@/lib/order-profit'
```

Replace:

```typescript
    const mappedLineCount = mappableLines.filter(l => l.resolvedSupplierId && l.resolvedBaseCost != null).length
```

with:

```typescript
    const mappedLineCount = mappableLines.filter(l => l.resolvedSupplierId && effectiveBaseCost(l) != null).length
```

- [ ] **Step 3: Verify typecheck and full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc silent; vitest — only the pre-existing `tests/shopify-orders-sync.integration.test.ts` failure; everything else passes.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/fulfillment/export/route.ts src/lib/repos/reports.ts
git commit -m "feat: CSV export and mapping count use effective base cost"
```

---

### Task 6: Inline editor in order detail modal

**Files:**
- Modify: `src/app/orders/page.tsx` (line type ~line 33, state ~line 108, handler near `load`, table ~lines 664–690)

The Orders page already receives full Prisma line objects from `GET /api/fulfillment/orders` (via `ordersWithComputedPL` → `listOrdersWithLines`, which uses `include: { lines: ... }`), so `manualBaseCost` and `resolvedSupplierId` are in the payload once the schema has them — only the TS type needs updating.

- [ ] **Step 1: Extend the line type**

In the `OrderRow` type, add two fields to `lines` entries (after `resolvedBaseCost`):

```typescript
    resolvedSupplierSku: string | null
    resolvedBaseCost: number | null
    manualBaseCost: number | null
    resolvedSupplierId: string | null
```

- [ ] **Step 2: Add edit state and save handler**

Near the other `useState` calls (after `const [selectedOrder, setSelectedOrder] = ...`):

```typescript
  const [editingLineId, setEditingLineId] = useState<string | null>(null)
  const [editCost, setEditCost] = useState('')
  const [savingLineCost, setSavingLineCost] = useState(false)
```

After the `load` callback definition, add:

```typescript
  async function saveLineCost(lineId: string, value: number | null) {
    if (savingLineCost) return
    setSavingLineCost(true)
    try {
      const res = await fetch('/api/fulfillment/orders/line-cost', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId, manualBaseCost: value }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Lưu base cost thất bại')
      }
      setEditingLineId(null)
      setSelectedOrder(prev => prev ? {
        ...prev,
        lines: prev.lines.map(l => l.id === lineId ? { ...l, manualBaseCost: value } : l),
      } : prev)
      await load()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setSavingLineCost(false)
    }
  }
```

- [ ] **Step 3: Add the Base cost column**

In the modal's Line items table header, after the `Total` `<th>`:

```tsx
                          <th className="px-md py-sm text-right">Base cost</th>
```

In the body row, after the `Total` `<td>`:

```tsx
                            <td className="px-md py-sm text-right">
                              {editingLineId === line.id ? (
                                <input
                                  autoFocus
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={editCost}
                                  disabled={savingLineCost}
                                  onChange={e => setEditCost(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      const v = parseFloat(editCost)
                                      if (!isNaN(v) && v >= 0) saveLineCost(line.id, v)
                                    }
                                    if (e.key === 'Escape') setEditingLineId(null)
                                  }}
                                  onBlur={() => {
                                    const v = parseFloat(editCost)
                                    if (!isNaN(v) && v >= 0) saveLineCost(line.id, v)
                                    else setEditingLineId(null)
                                  }}
                                  className="w-[90px] rounded border border-outline-variant/40 px-xs py-[2px] text-right text-body-sm"
                                />
                              ) : line.resolvedSupplierId ? (
                                <span className="inline-flex items-center justify-end gap-xs">
                                  <button
                                    onClick={() => {
                                      setEditingLineId(line.id)
                                      setEditCost(String(line.manualBaseCost ?? line.resolvedBaseCost ?? ''))
                                    }}
                                    title="Click để sửa base cost"
                                    className="underline decoration-dotted underline-offset-2"
                                  >
                                    {(line.manualBaseCost ?? line.resolvedBaseCost) != null
                                      ? fmt(line.manualBaseCost ?? line.resolvedBaseCost ?? 0, selectedOrder.currency)
                                      : '—'}
                                  </button>
                                  {line.manualBaseCost != null && (
                                    <>
                                      <span className="rounded bg-secondary-container px-xs text-label-sm">manual</span>
                                      <button
                                        onClick={() => saveLineCost(line.id, null)}
                                        title="Xóa manual, quay về giá auto"
                                        className="text-error"
                                      >
                                        ✕
                                      </button>
                                    </>
                                  )}
                                </span>
                              ) : (
                                <span>—</span>
                              )}
                            </td>
```

(Enter triggers save, which unmounts the input and fires `onBlur`; the `savingLineCost` guard in `saveLineCost` prevents a double PATCH.)

- [ ] **Step 4: Verify typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 5: Manual smoke test**

Run dev server: `npm run dev -- --port 3002`, log in, open `/orders`, click an order with mapped lines:
- Base cost column shows the resolved cost; click → input appears; enter a new value + Enter → badge `manual` appears, order COGS/profit in the list refreshes.
- Click ✕ → value returns to the auto price, badge disappears.
- A line without supplier mapping shows `—` and is not clickable.

- [ ] **Step 6: Commit**

```bash
git add src/app/orders/page.tsx
git commit -m "feat: inline manual base cost editor in order detail modal"
```

---

### Task 7: Sync spec, final verification

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-manual-base-cost-design.md` (API path)

- [ ] **Step 1: Update the spec's API path**

In the spec, replace `PATCH /api/orders/line-cost` with `PATCH /api/fulfillment/orders/line-cost` (matches the implemented route).

- [ ] **Step 2: Full verification**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc silent; vitest — only the pre-existing shopify-orders-sync integration failure; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-11-manual-base-cost-design.md
git commit -m "docs: align manual base cost spec with implemented API path"
```
