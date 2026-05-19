# Fulfillment & POD — Phase 1: Foundation + Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the data layer + Shopify order sync for Phase 13 (Fulfillment & POD). End state: 6 new Prisma models migrated, 3 pure libraries unit-tested, sync route pulls real Shopify orders + transactions + fees, read API returns orders with computed P/L. No major UI yet — just a minimal `/orders` page to verify sync end-to-end.

**Architecture:**
- **Multi-tenant:** 1 Shopify store = 1 Project. `ShopifyStore.projectId` UNIQUE. `Order.projectId` required. Suppliers / SupplierProduct / CsvTemplate are SHARED (global, no `projectId`).
- **Soft delete:** `Project.archivedAt DateTime?`. Queries default-filter `archivedAt IS NULL`.
- **Repository pattern:** Routes never import `prisma` directly — must go through `src/lib/repos/<domain>.ts`. Cross-domain reports go through `src/lib/repos/reports.ts`. Prevents project-scope leaks and isolates DB access.
- Pure functions for P/L math, CSV templating, timezone — fully unit-tested with Vitest.
- GraphQL client for Shopify Admin API 2024-10 (cost-aware, paginated).
- Snapshot-on-sync pattern: `OrderLine.resolvedBaseCost` is frozen at sync time so cost edits later don't rewrite history.
- All API routes follow existing convention (`src/app/api/<feature>/route.ts`, return `NextResponse.json`).

**Tech Stack:** Next.js 14 App Router · Prisma v7.8 (LibSQL adapter) · SQLite · Vitest (new) · Shopify GraphQL Admin API 2024-10 · TypeScript.

**Spec reference:** [`docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md`](../specs/2026-05-19-fulfillment-pod-design.md) — read Section 2 (data model) + Section 6 (sync logic) before starting.

**Path naming note:** Spec used `/fulfillment` for the new module. Project already has `/finance/fulfillment` (invoice-based cost entry). This plan uses **`/orders`** for the per-order P/L module to avoid collision. Spec will be updated after Plan 1 is shipped.

---

## File Structure

### New files
| Path | Responsibility |
|---|---|
| `src/lib/pl-calculator.ts` | Pure function: order + supplier price map → P/L breakdown |
| `src/lib/csv-template.ts` | Pure function: template + orders → CSV string |
| `src/lib/timezone.ts` | VN ⇄ US time conversion + day-boundary helpers |
| `src/lib/shopify-orders.ts` | GraphQL client (fetch orders w/ transactions, fees, refunds, paginated) |
| `src/lib/repos/projects.ts` | Project queries (list active, getById, archive) |
| `src/lib/repos/orders.ts` | Order CRUD + reads, ALWAYS scoped by `projectId` |
| `src/lib/repos/suppliers.ts` | Supplier + SupplierProduct queries (global, no project scope) |
| `src/lib/repos/reports.ts` | Cross-domain P/L aggregates (only file allowed to JOIN multi-module) |
| `tests/pl-calculator.test.ts` | Unit tests |
| `tests/csv-template.test.ts` | Unit tests |
| `tests/timezone.test.ts` | Unit tests |
| `tests/shopify-orders-sync.integration.test.ts` | Integration test for sync route w/ mocked GraphQL |
| `vitest.config.ts` | Vitest config |
| `src/app/api/shopify/orders/sync/route.ts` | POST – pull orders + upsert |
| `src/app/api/shopify/orders/route.ts` | GET – read orders from DB w/ filter |
| `src/app/api/fulfillment/orders/route.ts` | GET – orders w/ P/L computed |
| `src/app/api/fulfillment/pl-summary/route.ts` | GET – aggregate stats |
| `src/app/orders/page.tsx` | Minimal dashboard placeholder (sync button + table) |

### Modified files
| Path | Change |
|---|---|
| `prisma/schema.prisma` | Add 6 fulfillment models + ShopifyStore.{projectId, syncSinceDate} + Order.projectId + Project.archivedAt |
| `src/lib/db.ts` | Bump SCHEMA_VERSION v8 → v9 |
| `src/components/Sidebar.tsx` | Add Orders entry under Finance group |
| `package.json` | Add vitest, @vitest/ui, vite-tsconfig-paths deps |
| `NOTES.md` | Update active phase + active data after migration |
| `PLAN.md` | Mark Phase 13.1+13.2 done after completion |

---

## Task 1: Add Vitest test framework

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install Vitest + adapter**

Run:
```powershell
cd "C:\Users\TM PC\Desktop\Ecom manager\ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npm install -D vitest @vitest/ui vite-tsconfig-paths @types/node
```

Expected: `package.json` updated; `node_modules/vitest` exists.

- [ ] **Step 2: Create Vitest config**

Create `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import path from 'path'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

- [ ] **Step 3: Add npm scripts**

Edit `package.json` scripts block:
```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:ui": "vitest --ui"
}
```

- [ ] **Step 4: Verify Vitest runs (no tests yet)**

Run: `npm test`
Expected: "No test files found, exiting with code 0" (or 1 — accept both as long as Vitest binary executed without import errors).

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest test framework for fulfillment module"
```

---

## Task 2: Prisma schema — add fulfillment models

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Append new models to schema**

Open `prisma/schema.prisma` and append at the END of the file:
```prisma
model Supplier {
  id                    String                @id @default(cuid())
  name                  String
  code                  String                @unique
  apiType               String?
  apiKey                String?
  firstItemShipFee      Float                 @default(0)
  additionalItemShipFee Float                 @default(0)
  currency              String                @default("USD")
  preferenceRank        Int                   @default(0)
  note                  String?
  isActive              Boolean               @default(true)
  createdAt             DateTime              @default(now())
  products              SupplierProduct[]
  templates             CsvTemplate[]
  orders                Order[]
  costHistory           SupplierCostHistory[]
}

model SupplierProduct {
  id          String   @id @default(cuid())
  supplierId  String
  supplier    Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  sku         String
  productName String?
  baseCost    Float
  currency    String   @default("USD")
  updatedAt   DateTime @updatedAt
  createdAt   DateTime @default(now())
  @@unique([supplierId, sku])
  @@index([sku])
}

model SupplierCostHistory {
  id         String   @id @default(cuid())
  supplierId String
  supplier   Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  sku        String
  oldCost    Float
  newCost    Float
  changedAt  DateTime @default(now())
  @@index([supplierId, sku])
}

model Order {
  id                   String      @id
  storeId              String
  projectId            String
  project              Project     @relation(fields: [projectId], references: [id])
  shopifyOrderNumber   String
  customerEmail        String?
  customerName         String?
  shippingCountry      String?
  shippingState        String?
  financialStatus      String
  fulfillmentStatus    String?
  pipelineStatus       String      @default("PENDING")
  currency             String
  grossAmount          Float
  expectedPayout       Float
  totalFees            Float       @default(0)
  refundedAmount       Float       @default(0)
  defaultSupplierId    String?
  defaultSupplier      Supplier?   @relation(fields: [defaultSupplierId], references: [id])
  exportedAt           DateTime?
  exportedToSupplierId String?
  placedAt             DateTime
  fetchedAt            DateTime    @default(now())
  updatedAt            DateTime    @updatedAt
  lines                OrderLine[]
  @@index([placedAt])
  @@index([pipelineStatus])
  @@index([defaultSupplierId])
  @@index([projectId])
  @@index([projectId, placedAt])
}

model OrderLine {
  id                 String    @id @default(cuid())
  orderId            String
  order              Order     @relation(fields: [orderId], references: [id], onDelete: Cascade)
  shopifyLineId      String
  sku                String?
  variantTitle       String?
  productTitle       String
  qty                Int
  unitPrice          Float
  resolvedSupplierId String?
  resolvedBaseCost   Float?
  costSnapshotAt     DateTime?
  @@index([sku])
}

model CsvTemplate {
  id         String   @id @default(cuid())
  supplierId String
  supplier   Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  name       String
  columns    String
  rowMode    String   @default("PER_LINE")
  isDefault  Boolean  @default(false)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}
```

- [ ] **Step 2: Update ShopifyStore and Project for multi-tenancy + syncSinceDate**

In `prisma/schema.prisma`:

(a) Add to `ShopifyStore` model (before closing `}`):
```prisma
  syncSinceDate          DateTime?
  projectId              String?       @unique
  project                Project?      @relation(fields: [projectId], references: [id])
```

(b) Add to `Project` model (before closing `}`):
```prisma
  archivedAt   DateTime?
  shopifyStore ShopifyStore?
  orders       Order[]
```
(The `shopifyStore` back-relation and `orders` back-relation are needed for Prisma's relation system.)

- [ ] **Step 3: Run migration**

Run:
```powershell
cd "C:\Users\TM PC\Desktop\Ecom manager\ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --name add_fulfillment_pod_module
```

Expected: New migration file at `prisma/migrations/<timestamp>_add_fulfillment_pod_module/migration.sql`, no errors.

- [ ] **Step 4: Regenerate Prisma client**

Run:
```powershell
npx prisma generate
```

Expected: "Generated Prisma Client to ./src/generated/prisma".

- [ ] **Step 5: Bump SCHEMA_VERSION**

Edit `src/lib/db.ts` line 6:
```typescript
const SCHEMA_VERSION = 'v9' // bump this to force singleton reset after schema changes
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors. If errors mention missing types from `@/generated/prisma/client`, re-run `npx prisma generate`.

- [ ] **Step 7: Commit**

```powershell
git add prisma/schema.prisma prisma/migrations src/lib/db.ts
git commit -m "feat(schema): add 6 fulfillment models, multi-tenant projectId on Order/Store, Project.archivedAt"
```

---

## Task 2.5: Repository layer foundation

**Files:**
- Create: `src/lib/repos/projects.ts`
- Create: `src/lib/repos/orders.ts`
- Create: `src/lib/repos/suppliers.ts`
- Create: `src/lib/repos/reports.ts`

**Rationale:** Routes never import `prisma` directly; they call repos. Each repo encloses queries for one domain and enforces `projectId` scope. Reports repo is the only place allowed to JOIN multi-module data.

- [ ] **Step 1: Create projects repo**

Create `src/lib/repos/projects.ts`:
```typescript
import { prisma } from '@/lib/db'

export type ProjectListOptions = { includeArchived?: boolean }

export async function listProjects(opts: ProjectListOptions = {}) {
  return prisma.project.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { shopifyStore: { select: { shop: true } } },
  })
}

export async function getProjectById(id: string, opts: ProjectListOptions = {}) {
  return prisma.project.findFirst({
    where: { id, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    include: { shopifyStore: true },
  })
}

export async function archiveProject(id: string) {
  return prisma.project.update({
    where: { id },
    data: { archivedAt: new Date() },
  })
}

export async function unarchiveProject(id: string) {
  return prisma.project.update({
    where: { id },
    data: { archivedAt: null },
  })
}

export async function getProjectByStoreShop(shop: string) {
  const store = await prisma.shopifyStore.findUnique({
    where: { shop },
    include: { project: true },
  })
  return store?.project ?? null
}
```

- [ ] **Step 2: Create suppliers repo**

Create `src/lib/repos/suppliers.ts`:
```typescript
import { prisma } from '@/lib/db'
import type { SupplierInput } from '@/lib/pl-calculator'

export async function listActiveSuppliers() {
  return prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } })
}

export async function getSupplierById(id: string) {
  return prisma.supplier.findUnique({ where: { id } })
}

/**
 * Build global SKU → SupplierInput map for P/L calculation.
 * If 2+ suppliers map same SKU, pick the one with highest preferenceRank.
 * Shared across all projects (suppliers are global).
 */
export async function buildSkuPriceMap(): Promise<Record<string, SupplierInput>> {
  const suppliers = await prisma.supplier.findMany({ where: { isActive: true } })
  const products = await prisma.supplierProduct.findMany()
  const byId = new Map(suppliers.map(s => [s.id, s]))
  const map: Record<string, SupplierInput> = {}
  for (const p of products) {
    const sup = byId.get(p.supplierId)
    if (!sup) continue
    const existing = map[p.sku]
    const existingRank = existing ? (byId.get(existing.supplierId)?.preferenceRank ?? 0) : -Infinity
    if (!existing || sup.preferenceRank > existingRank) {
      map[p.sku] = {
        supplierId: sup.id,
        baseCost: p.baseCost,
        firstItemShipFee: sup.firstItemShipFee,
        additionalItemShipFee: sup.additionalItemShipFee,
      }
    }
  }
  return map
}
```

- [ ] **Step 3: Create orders repo**

Create `src/lib/repos/orders.ts`:
```typescript
import { prisma } from '@/lib/db'

export type OrderFilter = {
  projectId?: string
  dateFrom?: Date
  dateTo?: Date
  supplierId?: string
  pipelineStatus?: string
  limit?: number
}

function buildWhere(f: OrderFilter) {
  const where: any = {}
  if (f.projectId) where.projectId = f.projectId
  if (f.supplierId) where.defaultSupplierId = f.supplierId
  if (f.pipelineStatus) where.pipelineStatus = f.pipelineStatus
  if (f.dateFrom || f.dateTo) {
    where.placedAt = {}
    if (f.dateFrom) where.placedAt.gte = f.dateFrom
    if (f.dateTo) where.placedAt.lte = f.dateTo
  }
  return where
}

export async function listOrdersWithLines(filter: OrderFilter) {
  return prisma.order.findMany({
    where: buildWhere(filter),
    orderBy: { placedAt: 'desc' },
    take: filter.limit ?? 500,
    include: {
      lines: true,
      defaultSupplier: { select: { id: true, name: true, code: true, firstItemShipFee: true, additionalItemShipFee: true } },
    },
  })
}

export type UpsertOrderInput = {
  id: string
  projectId: string
  storeId: string
  shopifyOrderNumber: string
  customerEmail: string | null
  customerName: string | null
  shippingCountry: string | null
  shippingState: string | null
  financialStatus: string
  fulfillmentStatus: string | null
  currency: string
  grossAmount: number
  expectedPayout: number
  totalFees: number
  refundedAmount: number
  defaultSupplierId: string | null
  placedAt: Date
  lines: Array<{
    shopifyLineId: string
    sku: string | null
    variantTitle: string | null
    productTitle: string
    qty: number
    unitPrice: number
    resolvedSupplierId: string | null
    resolvedBaseCost: number | null
  }>
}

export async function upsertOrderWithLines(input: UpsertOrderInput) {
  const now = new Date()
  await prisma.$transaction([
    prisma.orderLine.deleteMany({ where: { orderId: input.id } }),
    prisma.order.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        projectId: input.projectId,
        storeId: input.storeId,
        shopifyOrderNumber: input.shopifyOrderNumber,
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        shippingCountry: input.shippingCountry,
        shippingState: input.shippingState,
        financialStatus: input.financialStatus,
        fulfillmentStatus: input.fulfillmentStatus,
        currency: input.currency,
        grossAmount: input.grossAmount,
        expectedPayout: input.expectedPayout,
        totalFees: input.totalFees,
        refundedAmount: input.refundedAmount,
        defaultSupplierId: input.defaultSupplierId,
        placedAt: input.placedAt,
      },
      update: {
        financialStatus: input.financialStatus,
        fulfillmentStatus: input.fulfillmentStatus,
        grossAmount: input.grossAmount,
        expectedPayout: input.expectedPayout,
        totalFees: input.totalFees,
        refundedAmount: input.refundedAmount,
        defaultSupplierId: input.defaultSupplierId,
        placedAt: input.placedAt,
      },
    }),
    prisma.orderLine.createMany({
      data: input.lines.map(l => ({
        orderId: input.id,
        shopifyLineId: l.shopifyLineId,
        sku: l.sku,
        variantTitle: l.variantTitle,
        productTitle: l.productTitle,
        qty: l.qty,
        unitPrice: l.unitPrice,
        resolvedSupplierId: l.resolvedSupplierId,
        resolvedBaseCost: l.resolvedBaseCost,
        costSnapshotAt: l.resolvedSupplierId ? now : null,
      })),
    }),
  ])
}
```

- [ ] **Step 4: Create reports repo (cross-domain aggregate)**

Create `src/lib/repos/reports.ts`:
```typescript
import { listOrdersWithLines, type OrderFilter } from './orders'

export type PlSummary = {
  orderCount: number
  revenue: number
  cogs: number
  shipping: number
  profit: number
  margin: number
  avgProfit: number
  unmappedCount: number
}

export async function plSummary(filter: OrderFilter): Promise<PlSummary> {
  const orders = await listOrdersWithLines(filter)
  let revenue = 0, cogs = 0, shipping = 0, unmappedCount = 0
  for (const o of orders) {
    revenue += o.expectedPayout
    const totalQty = o.lines.reduce((s, l) => s + l.qty, 0)
    cogs += o.lines.reduce((s, l) => s + (l.resolvedBaseCost ?? 0) * l.qty, 0)
    if (o.defaultSupplier) {
      shipping += o.defaultSupplier.firstItemShipFee + o.defaultSupplier.additionalItemShipFee * Math.max(0, totalQty - 1)
    }
    if (o.lines.some(l => l.resolvedBaseCost == null)) unmappedCount++
  }
  const profit = revenue - cogs - shipping
  const margin = revenue === 0 ? 0 : (profit / revenue) * 100
  const avgProfit = orders.length === 0 ? 0 : profit / orders.length
  return { orderCount: orders.length, revenue, cogs, shipping, profit, margin, avgProfit, unmappedCount }
}

export type EnrichedOrder = Awaited<ReturnType<typeof listOrdersWithLines>>[number] & {
  computed: { totalQty: number; baseCost: number; shipping: number; profit: number; margin: number; hasUnmappedSku: boolean }
}

export async function ordersWithComputedPL(filter: OrderFilter): Promise<EnrichedOrder[]> {
  const orders = await listOrdersWithLines(filter)
  return orders.map(o => {
    const totalQty = o.lines.reduce((s, l) => s + l.qty, 0)
    const baseCost = o.lines.reduce((s, l) => s + (l.resolvedBaseCost ?? 0) * l.qty, 0)
    const shipping = o.defaultSupplier
      ? o.defaultSupplier.firstItemShipFee + o.defaultSupplier.additionalItemShipFee * Math.max(0, totalQty - 1)
      : 0
    const profit = o.expectedPayout - baseCost - shipping
    const margin = o.expectedPayout === 0 ? 0 : (profit / o.expectedPayout) * 100
    const hasUnmappedSku = o.lines.some(l => l.resolvedBaseCost == null)
    return { ...o, computed: { totalQty, baseCost, shipping, profit, margin, hasUnmappedSku } }
  })
}
```

- [ ] **Step 5: TypeScript compile**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/repos
git commit -m "feat(repos): repository layer for projects/orders/suppliers/reports with project-scope enforcement"
```

---

## Task 3: TDD pl-calculator — basic single-line order

**Files:**
- Create: `tests/pl-calculator.test.ts`
- Create: `src/lib/pl-calculator.ts`

- [ ] **Step 1: Write failing test for single-line order**

Create `tests/pl-calculator.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { computeOrderPL, type OrderInput, type SupplierInput } from '@/lib/pl-calculator'

describe('computeOrderPL', () => {
  it('computes profit for single-line order with one supplier', () => {
    const order: OrderInput = {
      grossAmount: 149.99,
      totalFees: 4.65,
      refundedAmount: 0,
      lines: [
        { sku: 'TSHIRT-RED-M', qty: 1, unitPrice: 149.99 },
      ],
    }
    const supplierMap: Record<string, SupplierInput> = {
      'TSHIRT-RED-M': {
        supplierId: 'sup_printful',
        baseCost: 48.20,
        firstItemShipFee: 4.99,
        additionalItemShipFee: 2.99,
      },
    }
    const result = computeOrderPL(order, supplierMap)
    expect(result.expectedPayout).toBeCloseTo(145.34, 2)  // 149.99 - 4.65
    expect(result.totalBaseCost).toBeCloseTo(48.20, 2)
    expect(result.totalShipping).toBeCloseTo(4.99, 2)     // first item only
    expect(result.profit).toBeCloseTo(92.15, 2)           // 145.34 - 48.20 - 4.99
    expect(result.defaultSupplierId).toBe('sup_printful')
    expect(result.hasUnmappedSku).toBe(false)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test`
Expected: FAIL — "Cannot find module '@/lib/pl-calculator'" or similar import error.

- [ ] **Step 3: Create minimal implementation**

Create `src/lib/pl-calculator.ts`:
```typescript
export type OrderLineInput = {
  sku: string | null
  qty: number
  unitPrice: number
}

export type OrderInput = {
  grossAmount: number
  totalFees: number
  refundedAmount: number
  lines: OrderLineInput[]
}

export type SupplierInput = {
  supplierId: string
  baseCost: number
  firstItemShipFee: number
  additionalItemShipFee: number
}

export type OrderPLResult = {
  expectedPayout: number
  totalBaseCost: number
  totalShipping: number
  profit: number
  marginPct: number
  defaultSupplierId: string | null
  hasUnmappedSku: boolean
  isMixedSupplier: boolean
  perLineCost: Array<{ sku: string | null; resolvedSupplierId: string | null; resolvedBaseCost: number | null }>
}

export function computeOrderPL(
  order: OrderInput,
  supplierMap: Record<string, SupplierInput>
): OrderPLResult {
  const expectedPayout = order.grossAmount - order.totalFees - order.refundedAmount

  let totalBaseCost = 0
  let totalQty = 0
  const supplierQty: Record<string, number> = {}
  let hasUnmappedSku = false
  const perLineCost: OrderPLResult['perLineCost'] = []

  for (const line of order.lines) {
    totalQty += line.qty
    const sup = line.sku ? supplierMap[line.sku] : undefined
    if (!sup) {
      hasUnmappedSku = true
      perLineCost.push({ sku: line.sku, resolvedSupplierId: null, resolvedBaseCost: null })
      continue
    }
    totalBaseCost += sup.baseCost * line.qty
    supplierQty[sup.supplierId] = (supplierQty[sup.supplierId] || 0) + line.qty
    perLineCost.push({ sku: line.sku, resolvedSupplierId: sup.supplierId, resolvedBaseCost: sup.baseCost })
  }

  const supplierIds = Object.keys(supplierQty)
  const defaultSupplierId = supplierIds.length === 0
    ? null
    : supplierIds.reduce((a, b) => supplierQty[a] >= supplierQty[b] ? a : b)
  const isMixedSupplier = supplierIds.length > 1 &&
    (supplierIds.filter(id => supplierQty[id] === supplierQty[defaultSupplierId!]).length > 1)

  let totalShipping = 0
  if (defaultSupplierId) {
    const sup = Object.values(supplierMap).find(s => s.supplierId === defaultSupplierId)!
    totalShipping = sup.firstItemShipFee + sup.additionalItemShipFee * Math.max(0, totalQty - 1)
  }

  const profit = expectedPayout - totalBaseCost - totalShipping
  const marginPct = expectedPayout === 0 ? 0 : (profit / expectedPayout) * 100

  return {
    expectedPayout,
    totalBaseCost,
    totalShipping,
    profit,
    marginPct,
    defaultSupplierId: isMixedSupplier ? null : defaultSupplierId,
    hasUnmappedSku,
    isMixedSupplier,
    perLineCost,
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test`
Expected: PASS — 1 test passing.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/pl-calculator.ts tests/pl-calculator.test.ts
git commit -m "feat(pl-calculator): single-line order profit calculation"
```

---

## Task 4: TDD pl-calculator — multi-line + shipping math

**Files:**
- Modify: `tests/pl-calculator.test.ts`

- [ ] **Step 1: Add failing test for multi-line same-supplier**

Append to `tests/pl-calculator.test.ts` inside the `describe`:
```typescript
  it('computes shipping correctly for 3-item order (first + 2 additional)', () => {
    const order: OrderInput = {
      grossAmount: 300,
      totalFees: 9,
      refundedAmount: 0,
      lines: [
        { sku: 'A', qty: 2, unitPrice: 100 },
        { sku: 'B', qty: 1, unitPrice: 100 },
      ],
    }
    const supplierMap: Record<string, SupplierInput> = {
      A: { supplierId: 'sup1', baseCost: 30, firstItemShipFee: 5, additionalItemShipFee: 2 },
      B: { supplierId: 'sup1', baseCost: 40, firstItemShipFee: 5, additionalItemShipFee: 2 },
    }
    const r = computeOrderPL(order, supplierMap)
    expect(r.totalBaseCost).toBeCloseTo(2 * 30 + 1 * 40, 2)   // 100
    expect(r.totalShipping).toBeCloseTo(5 + 2 * 2, 2)         // 5 first + 2*2 additional = 9
    expect(r.expectedPayout).toBeCloseTo(291, 2)              // 300 - 9
    expect(r.profit).toBeCloseTo(291 - 100 - 9, 2)            // 182
    expect(r.defaultSupplierId).toBe('sup1')
    expect(r.isMixedSupplier).toBe(false)
  })
```

- [ ] **Step 2: Run test, verify it passes**

Run: `npm test`
Expected: PASS (the implementation should already handle this).

- [ ] **Step 3: Add failing test for mixed-supplier tie**

Append to `tests/pl-calculator.test.ts`:
```typescript
  it('flags isMixedSupplier and null defaultSupplierId for 50/50 split', () => {
    const order: OrderInput = {
      grossAmount: 200,
      totalFees: 0,
      refundedAmount: 0,
      lines: [
        { sku: 'A', qty: 1, unitPrice: 100 },
        { sku: 'B', qty: 1, unitPrice: 100 },
      ],
    }
    const supplierMap: Record<string, SupplierInput> = {
      A: { supplierId: 'sup1', baseCost: 30, firstItemShipFee: 5, additionalItemShipFee: 2 },
      B: { supplierId: 'sup2', baseCost: 40, firstItemShipFee: 6, additionalItemShipFee: 3 },
    }
    const r = computeOrderPL(order, supplierMap)
    expect(r.isMixedSupplier).toBe(true)
    expect(r.defaultSupplierId).toBe(null)
  })
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Add failing test for unmapped SKU**

Append to `tests/pl-calculator.test.ts`:
```typescript
  it('flags hasUnmappedSku and excludes unmapped line from cost', () => {
    const order: OrderInput = {
      grossAmount: 100,
      totalFees: 3,
      refundedAmount: 0,
      lines: [
        { sku: 'KNOWN', qty: 1, unitPrice: 50 },
        { sku: 'UNKNOWN', qty: 1, unitPrice: 50 },
      ],
    }
    const supplierMap: Record<string, SupplierInput> = {
      KNOWN: { supplierId: 'sup1', baseCost: 20, firstItemShipFee: 5, additionalItemShipFee: 2 },
    }
    const r = computeOrderPL(order, supplierMap)
    expect(r.hasUnmappedSku).toBe(true)
    expect(r.totalBaseCost).toBeCloseTo(20, 2)
    expect(r.perLineCost[1].resolvedBaseCost).toBe(null)
  })
```

- [ ] **Step 6: Run test, verify it passes**

Run: `npm test`
Expected: PASS — 4 tests passing.

- [ ] **Step 7: Add failing test for refund handling**

Append to `tests/pl-calculator.test.ts`:
```typescript
  it('subtracts refundedAmount from expectedPayout', () => {
    const order: OrderInput = {
      grossAmount: 100,
      totalFees: 3,
      refundedAmount: 20,
      lines: [{ sku: 'A', qty: 1, unitPrice: 100 }],
    }
    const supplierMap: Record<string, SupplierInput> = {
      A: { supplierId: 'sup1', baseCost: 30, firstItemShipFee: 5, additionalItemShipFee: 2 },
    }
    const r = computeOrderPL(order, supplierMap)
    expect(r.expectedPayout).toBeCloseTo(77, 2)   // 100 - 3 - 20
    expect(r.profit).toBeCloseTo(77 - 30 - 5, 2)  // 42
  })
```

- [ ] **Step 8: Run test, verify it passes**

Run: `npm test`
Expected: PASS — 5 tests passing.

- [ ] **Step 9: Commit**

```powershell
git add tests/pl-calculator.test.ts
git commit -m "test(pl-calculator): cover multi-line, mixed-supplier, unmapped, refund cases"
```

---

## Task 5: TDD csv-template — renderer engine

**Files:**
- Create: `tests/csv-template.test.ts`
- Create: `src/lib/csv-template.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/csv-template.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { renderCsv, type CsvTemplate, type OrderForCsv } from '@/lib/csv-template'

const sampleOrder: OrderForCsv = {
  shopifyOrderNumber: '#1023',
  customerName: 'David Olsen',
  customerEmail: 'd@x.com',
  shippingCountry: 'US',
  shippingState: 'CA',
  placedAt: new Date('2026-05-18T07:06:00Z'),
  lines: [
    { sku: 'TSHIRT-RED-M', qty: 2, productTitle: 'Tee', variantTitle: 'Red / M' },
    { sku: 'HOODIE-BLK-L', qty: 1, productTitle: 'Hoodie', variantTitle: 'Black / L' },
  ],
}

describe('renderCsv', () => {
  it('renders PER_LINE rows with one row per line item', () => {
    const tmpl: CsvTemplate = {
      rowMode: 'PER_LINE',
      columns: [
        { header: 'OrderID', source: 'order.shopifyOrderNumber' },
        { header: 'SKU', source: 'line.sku' },
        { header: 'Qty', source: 'line.qty' },
      ],
    }
    const csv = renderCsv(tmpl, [sampleOrder])
    const rows = csv.split('\n')
    expect(rows[0]).toBe('OrderID,SKU,Qty')
    expect(rows[1]).toBe('#1023,TSHIRT-RED-M,2')
    expect(rows[2]).toBe('#1023,HOODIE-BLK-L,1')
    expect(rows).toHaveLength(3)
  })

  it('renders PER_ORDER with one row per order', () => {
    const tmpl: CsvTemplate = {
      rowMode: 'PER_ORDER',
      columns: [
        { header: 'OrderID', source: 'order.shopifyOrderNumber' },
        { header: 'Recipient', source: 'order.customerName' },
      ],
    }
    const csv = renderCsv(tmpl, [sampleOrder])
    expect(csv).toBe('OrderID,Recipient\n#1023,David Olsen')
  })

  it('supports literal: source', () => {
    const tmpl: CsvTemplate = {
      rowMode: 'PER_ORDER',
      columns: [{ header: 'Note', source: 'literal:Rush order' }],
    }
    expect(renderCsv(tmpl, [sampleOrder])).toBe('Note\nRush order')
  })

  it('CSV-escapes fields containing commas or quotes', () => {
    const order: OrderForCsv = { ...sampleOrder, customerName: 'Doe, John "Big"' }
    const tmpl: CsvTemplate = {
      rowMode: 'PER_ORDER',
      columns: [{ header: 'Name', source: 'order.customerName' }],
    }
    expect(renderCsv(tmpl, [order])).toBe('Name\n"Doe, John ""Big"""')
  })
})
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement renderer**

Create `src/lib/csv-template.ts`:
```typescript
export type CsvColumn = {
  header: string
  source: string
}

export type CsvTemplate = {
  rowMode: 'PER_LINE' | 'PER_ORDER'
  columns: CsvColumn[]
}

export type OrderLineForCsv = {
  sku: string | null
  qty: number
  productTitle: string
  variantTitle: string | null
}

export type OrderForCsv = {
  shopifyOrderNumber: string
  customerName: string | null
  customerEmail: string | null
  shippingCountry: string | null
  shippingState: string | null
  placedAt: Date
  lines: OrderLineForCsv[]
}

function resolveSource(source: string, ctx: { order: OrderForCsv; line: OrderLineForCsv | null }): string {
  if (source.startsWith('literal:')) return source.slice('literal:'.length)
  const parts = source.split('.')
  const root = parts[0]
  if (root === 'order') {
    const key = parts[1] as keyof OrderForCsv
    const val = ctx.order[key]
    if (val instanceof Date) return val.toISOString()
    return val == null ? '' : String(val)
  }
  if (root === 'line' && ctx.line) {
    const key = parts[1] as keyof OrderLineForCsv
    const val = ctx.line[key]
    return val == null ? '' : String(val)
  }
  return ''
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function renderCsv(template: CsvTemplate, orders: OrderForCsv[]): string {
  const rows: string[][] = []
  rows.push(template.columns.map(c => c.header))
  for (const order of orders) {
    if (template.rowMode === 'PER_ORDER') {
      rows.push(template.columns.map(c => resolveSource(c.source, { order, line: null })))
    } else {
      for (const line of order.lines) {
        rows.push(template.columns.map(c => resolveSource(c.source, { order, line })))
      }
    }
  }
  return rows.map(r => r.map(csvEscape).join(',')).join('\n')
}
```

- [ ] **Step 4: Run, verify passes**

Run: `npm test`
Expected: PASS — 4 csv-template tests pass; total now 9 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/csv-template.ts tests/csv-template.test.ts
git commit -m "feat(csv-template): renderer for PER_LINE/PER_ORDER modes with escape"
```

---

## Task 6: TDD timezone helper

**Files:**
- Create: `tests/timezone.test.ts`
- Create: `src/lib/timezone.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/timezone.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { dayBoundaryUS, formatBothZones, US_EASTERN, US_PACIFIC } from '@/lib/timezone'

describe('dayBoundaryUS', () => {
  it('returns start and end of day in US Eastern as UTC instants', () => {
    // 2026-05-19 in ET = UTC 2026-05-19T04:00:00 to 2026-05-20T03:59:59.999
    // (May = EDT, UTC-4)
    const { startUtc, endUtc } = dayBoundaryUS('2026-05-19', US_EASTERN)
    expect(startUtc.toISOString()).toBe('2026-05-19T04:00:00.000Z')
    expect(endUtc.toISOString()).toBe('2026-05-20T03:59:59.999Z')
  })

  it('handles US Pacific (PT) — UTC-7 in May (PDT)', () => {
    const { startUtc, endUtc } = dayBoundaryUS('2026-05-19', US_PACIFIC)
    expect(startUtc.toISOString()).toBe('2026-05-19T07:00:00.000Z')
    expect(endUtc.toISOString()).toBe('2026-05-20T06:59:59.999Z')
  })
})

describe('formatBothZones', () => {
  it('returns VN and US strings for an instant', () => {
    const d = new Date('2026-05-19T00:06:00Z')  // 07:06 ICT, 20:06 prev day ET
    const r = formatBothZones(d)
    expect(r.vn).toMatch(/2026-05-19 07:06/)
    expect(r.usEastern).toMatch(/2026-05-18 20:06/)
  })
})
```

- [ ] **Step 2: Run, verify fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helpers**

Create `src/lib/timezone.ts`:
```typescript
export const US_EASTERN = 'America/New_York' as const
export const US_PACIFIC = 'America/Los_Angeles' as const
export const VN_ZONE = 'Asia/Ho_Chi_Minh' as const

export type UsZone = typeof US_EASTERN | typeof US_PACIFIC

function getZoneOffsetMs(zone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(dtf.formatToParts(instant).map(p => [p.type, p.value]))
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute), Number(parts.second),
  )
  return asUtc - instant.getTime()
}

export function dayBoundaryUS(isoDate: string, zone: UsZone): { startUtc: Date; endUtc: Date } {
  // isoDate "YYYY-MM-DD" — interpreted as local date in `zone`
  const [y, m, d] = isoDate.split('-').map(Number)
  // Approximate the UTC time for midnight in target zone, then correct using actual offset
  const naive = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
  const offsetMs = getZoneOffsetMs(zone, naive)
  const startUtc = new Date(naive.getTime() - offsetMs)
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { startUtc, endUtc }
}

function formatInZone(d: Date, zone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(dtf.formatToParts(d).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`
}

export function formatBothZones(d: Date): { vn: string; usEastern: string; usPacific: string } {
  return {
    vn: formatInZone(d, VN_ZONE),
    usEastern: formatInZone(d, US_EASTERN),
    usPacific: formatInZone(d, US_PACIFIC),
  }
}
```

- [ ] **Step 4: Run, verify passes**

Run: `npm test`
Expected: PASS — 3 timezone tests pass; total now 12 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/timezone.ts tests/timezone.test.ts
git commit -m "feat(timezone): VN/US zone helpers with DST-aware boundaries"
```

---

## Task 7: Shopify GraphQL orders client

**Files:**
- Create: `src/lib/shopify-orders.ts`

- [ ] **Step 1: Implement GraphQL client**

Create `src/lib/shopify-orders.ts`:
```typescript
export type ShopifyOrdersPage = {
  orders: ShopifyOrder[]
  hasNextPage: boolean
  endCursor: string | null
}

export type ShopifyTransaction = {
  id: string
  kind: string                // SALE | CAPTURE | REFUND | AUTHORIZATION | VOID
  status: string              // SUCCESS | FAILURE | PENDING
  amount: number              // shopMoney
  fees: number                // sum of fees[].amount
  processedAt: string
}

export type ShopifyOrderLine = {
  id: string
  sku: string | null
  title: string
  variantTitle: string | null
  quantity: number
  unitPrice: number
}

export type ShopifyOrder = {
  id: string
  name: string
  createdAt: string
  processedAt: string | null
  financialStatus: string
  fulfillmentStatus: string | null
  currency: string
  grossAmount: number          // currentTotalPriceSet
  subtotal: number
  shipping: number
  tax: number
  taxMarketplaceCollected: number
  customerEmail: string | null
  customerName: string | null
  shippingCountry: string | null
  shippingState: string | null
  lines: ShopifyOrderLine[]
  transactions: ShopifyTransaction[]
  refundedAmount: number
}

const QUERY = `
query SyncOrders($cursor: String, $query: String) {
  orders(first: 50, after: $cursor, query: $query, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt processedAt
      displayFinancialStatus displayFulfillmentStatus
      currencyCode
      currentTotalPriceSet { shopMoney { amount } }
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      currentShippingPriceSet { shopMoney { amount } }
      customer { email displayName }
      shippingAddress { country countryCodeV2 province }
      taxLines { source priceSet { shopMoney { amount } } }
      lineItems(first: 50) {
        nodes {
          id sku title variantTitle quantity
          originalUnitPriceSet { shopMoney { amount } }
        }
      }
      transactions(first: 20) {
        id kind status processedAt
        amountSet { shopMoney { amount } }
        fees { amount { amount } }
      }
      refunds(first: 10) {
        totalRefundedSet { shopMoney { amount } }
      }
    }
  }
}`

function num(v: { shopMoney: { amount: string } } | null | undefined): number {
  if (!v) return 0
  return parseFloat(v.shopMoney.amount) || 0
}

export async function fetchOrdersPage(
  shop: string,
  accessToken: string,
  cursor: string | null,
  sinceIso: string,
  apiVersion = '2024-10',
): Promise<ShopifyOrdersPage> {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { cursor, query: `processed_at:>=${sinceIso}` },
    }),
  })
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`)
  const json = await res.json()
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)

  const conn = json.data.orders
  const orders: ShopifyOrder[] = conn.nodes.map((n: any) => {
    const transactions: ShopifyTransaction[] = (n.transactions || []).map((tx: any) => ({
      id: tx.id,
      kind: tx.kind,
      status: tx.status,
      amount: num(tx.amountSet),
      fees: (tx.fees || []).reduce((sum: number, f: any) => sum + parseFloat(f.amount?.amount || '0'), 0),
      processedAt: tx.processedAt,
    }))
    const refundedAmount = (n.refunds || []).reduce(
      (sum: number, r: any) => sum + num(r.totalRefundedSet), 0
    )
    const taxMarketplaceCollected = (n.taxLines || [])
      .filter((t: any) => t.source === 'marketplace')
      .reduce((sum: number, t: any) => sum + num(t.priceSet), 0)
    return {
      id: n.id,
      name: n.name,
      createdAt: n.createdAt,
      processedAt: n.processedAt,
      financialStatus: n.displayFinancialStatus,
      fulfillmentStatus: n.displayFulfillmentStatus,
      currency: n.currencyCode,
      grossAmount: num(n.currentTotalPriceSet),
      subtotal: num(n.currentSubtotalPriceSet),
      shipping: num(n.currentShippingPriceSet),
      tax: num(n.currentTotalTaxSet),
      taxMarketplaceCollected,
      customerEmail: n.customer?.email ?? null,
      customerName: n.customer?.displayName ?? null,
      shippingCountry: n.shippingAddress?.countryCodeV2 ?? n.shippingAddress?.country ?? null,
      shippingState: n.shippingAddress?.province ?? null,
      lines: (n.lineItems?.nodes || []).map((l: any) => ({
        id: l.id,
        sku: l.sku || null,
        title: l.title,
        variantTitle: l.variantTitle,
        quantity: l.quantity,
        unitPrice: num(l.originalUnitPriceSet),
      })),
      transactions,
      refundedAmount,
    }
  })
  return {
    orders,
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor: conn.pageInfo.endCursor,
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```powershell
git add src/lib/shopify-orders.ts
git commit -m "feat(shopify-orders): graphql client for orders + transactions + refunds"
```

---

## Task 8: Sync route — POST /api/shopify/orders/sync

**Files:**
- Create: `src/app/api/shopify/orders/sync/route.ts`

- [ ] **Step 1: Implement sync route using repos**

Create `src/app/api/shopify/orders/sync/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { fetchOrdersPage } from '@/lib/shopify-orders'
import { computeOrderPL } from '@/lib/pl-calculator'
import { buildSkuPriceMap } from '@/lib/repos/suppliers'
import { upsertOrderWithLines } from '@/lib/repos/orders'

export async function POST(req: NextRequest) {
  const shop = req.headers.get('x-shopify-shop-domain')
  const accessToken = req.headers.get('x-shopify-access-token')
  if (!shop || !accessToken) {
    return NextResponse.json({ error: 'Missing shop domain or access token headers' }, { status: 400 })
  }

  // Look up store + ensure linked to a project (multi-tenant requirement)
  const store = await prisma.shopifyStore.findUnique({
    where: { shop },
    include: { project: true },
  })
  if (!store) {
    return NextResponse.json({ error: 'Store not found in DB. Connect via /setup first.' }, { status: 404 })
  }
  if (!store.projectId || !store.project) {
    return NextResponse.json({
      error: 'Store not linked to a project. Go to /setup/projects and assign this store to a project.',
    }, { status: 400 })
  }
  if (store.project.archivedAt) {
    return NextResponse.json({ error: 'Project is archived; un-archive before syncing.' }, { status: 400 })
  }

  const sinceDate = store.syncSinceDate
    ?? new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  const sinceIso = sinceDate.toISOString().split('T')[0]

  // Suppliers are GLOBAL — single price map used across all projects
  const priceMap = await buildSkuPriceMap()

  let cursor: string | null = null
  let totalSynced = 0
  let withUnmappedSku = 0
  const errors: string[] = []

  do {
    let page
    try {
      page = await fetchOrdersPage(shop, accessToken, cursor, sinceIso)
    } catch (e: any) {
      errors.push(e.message)
      break
    }

    for (const o of page.orders) {
      const totalFees = o.transactions
        .filter(t => t.kind !== 'REFUND' && t.status === 'SUCCESS')
        .reduce((sum, t) => sum + t.fees, 0)
      const grossExcludingMarketplaceTax = o.grossAmount - o.taxMarketplaceCollected
      const pl = computeOrderPL(
        {
          grossAmount: grossExcludingMarketplaceTax,
          totalFees,
          refundedAmount: o.refundedAmount,
          lines: o.lines.map(l => ({ sku: l.sku, qty: l.quantity, unitPrice: l.unitPrice })),
        },
        priceMap,
      )
      if (pl.hasUnmappedSku) withUnmappedSku++

      await upsertOrderWithLines({
        id: o.id,
        projectId: store.projectId,
        storeId: store.id,
        shopifyOrderNumber: o.name,
        customerEmail: o.customerEmail,
        customerName: o.customerName,
        shippingCountry: o.shippingCountry,
        shippingState: o.shippingState,
        financialStatus: o.financialStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        currency: o.currency,
        grossAmount: grossExcludingMarketplaceTax,
        expectedPayout: pl.expectedPayout,
        totalFees,
        refundedAmount: o.refundedAmount,
        defaultSupplierId: pl.defaultSupplierId,
        placedAt: new Date(o.processedAt ?? o.createdAt),
        lines: o.lines.map((l, idx) => {
          const resolved = pl.perLineCost[idx]
          return {
            shopifyLineId: l.id,
            sku: l.sku,
            variantTitle: l.variantTitle,
            productTitle: l.title,
            qty: l.quantity,
            unitPrice: l.unitPrice,
            resolvedSupplierId: resolved.resolvedSupplierId,
            resolvedBaseCost: resolved.resolvedBaseCost,
          }
        }),
      })
      totalSynced++
    }
    cursor = page.hasNextPage ? page.endCursor : null
  } while (cursor)

  await prisma.shopifyStore.update({
    where: { id: store.id },
    data: { lastSyncAt: new Date() },
  })

  return NextResponse.json({
    totalSynced,
    withUnmappedSku,
    errors,
    projectId: store.projectId,
    projectName: store.project.name,
  })
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```powershell
git add src/app/api/shopify/orders/sync/route.ts
git commit -m "feat(api): POST /api/shopify/orders/sync — paginated order sync with P/L snapshot"
```

---

## Task 9: Integration test — sync route with mocked Shopify

**Files:**
- Create: `tests/shopify-orders-sync.integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `tests/shopify-orders-sync.integration.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { prisma } from '@/lib/db'

const SHOP = 'test-store.myshopify.com'
const TOKEN = 'test_token'

beforeAll(async () => {
  // Multi-tenant setup: project must exist + linked to store
  await prisma.project.upsert({
    where: { id: 'proj_test' },
    create: { id: 'proj_test', name: 'Test Project', startDate: new Date('2026-05-01') },
    update: { archivedAt: null },
  })
  await prisma.shopifyStore.upsert({
    where: { shop: SHOP },
    create: { shop: SHOP, syncSinceDate: new Date('2026-05-01'), projectId: 'proj_test' },
    update: { syncSinceDate: new Date('2026-05-01'), projectId: 'proj_test' },
  })
  await prisma.supplier.upsert({
    where: { code: 'test_sup' },
    create: {
      id: 'sup_test',
      name: 'Test Sup',
      code: 'test_sup',
      firstItemShipFee: 4.99,
      additionalItemShipFee: 2.99,
    },
    update: {},
  })
  await prisma.supplierProduct.upsert({
    where: { supplierId_sku: { supplierId: 'sup_test', sku: 'TSHIRT-RED-M' } },
    create: { supplierId: 'sup_test', sku: 'TSHIRT-RED-M', baseCost: 48.20 },
    update: { baseCost: 48.20 },
  })
})

afterAll(async () => {
  await prisma.orderLine.deleteMany({ where: { order: { storeId: { in: (await prisma.shopifyStore.findMany({ where: { shop: SHOP } })).map(s => s.id) } } } })
  await prisma.order.deleteMany({ where: { store: { shop: SHOP } } })
})

describe('POST /api/shopify/orders/sync', () => {
  it('upserts orders with computed P/L from mocked Shopify response', async () => {
    const mockResponse = {
      data: {
        orders: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: 'gid://shopify/Order/4090412213889',
            name: '#1023',
            createdAt: '2026-05-18T07:06:00Z',
            processedAt: '2026-05-18T07:06:00Z',
            displayFinancialStatus: 'PAID',
            displayFulfillmentStatus: 'UNFULFILLED',
            currencyCode: 'USD',
            currentTotalPriceSet: { shopMoney: { amount: '149.99' } },
            currentSubtotalPriceSet: { shopMoney: { amount: '149.99' } },
            currentTotalTaxSet: { shopMoney: { amount: '0' } },
            currentShippingPriceSet: { shopMoney: { amount: '0' } },
            customer: { email: 'smoothflight@yahoo.com', displayName: 'David Olsen' },
            shippingAddress: { country: 'United States', countryCodeV2: 'US', province: 'CA' },
            taxLines: [],
            lineItems: { nodes: [{
              id: 'gid://shopify/LineItem/1',
              sku: 'TSHIRT-RED-M',
              title: 'Premium Tee',
              variantTitle: 'Red / M',
              quantity: 1,
              originalUnitPriceSet: { shopMoney: { amount: '149.99' } },
            }] },
            transactions: [{
              id: 'gid://shopify/OrderTransaction/1',
              kind: 'SALE',
              status: 'SUCCESS',
              processedAt: '2026-05-18T07:06:00Z',
              amountSet: { shopMoney: { amount: '149.99' } },
              fees: [{ amount: { amount: '4.65' } }],
            }],
            refunds: [],
          }],
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
      text: async () => '',
    } as Response)

    const { POST } = await import('@/app/api/shopify/orders/sync/route')
    const req = new Request('http://test/api/shopify/orders/sync', {
      method: 'POST',
      headers: {
        'x-shopify-shop-domain': SHOP,
        'x-shopify-access-token': TOKEN,
      },
    })
    const res = await POST(req as any)
    const body = await res.json()

    expect(body.totalSynced).toBe(1)
    expect(body.withUnmappedSku).toBe(0)
    expect(body.projectId).toBe('proj_test')

    const saved = await prisma.order.findUnique({
      where: { id: 'gid://shopify/Order/4090412213889' },
      include: { lines: true },
    })
    expect(saved).not.toBeNull()
    expect(saved!.projectId).toBe('proj_test')
    expect(saved!.expectedPayout).toBeCloseTo(145.34, 2)
    expect(saved!.totalFees).toBeCloseTo(4.65, 2)
    expect(saved!.defaultSupplierId).toBe('sup_test')
    expect(saved!.lines).toHaveLength(1)
    expect(saved!.lines[0].resolvedBaseCost).toBeCloseTo(48.20, 2)

    fetchSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run integration test**

Run: `npm test`
Expected: PASS — integration test passes against real SQLite DB.

If test fails because store doesn't exist or prisma adapter issue, ensure dev.db exists and migrations ran in Task 2.

- [ ] **Step 3: Commit**

```powershell
git add tests/shopify-orders-sync.integration.test.ts
git commit -m "test(sync): integration test for /api/shopify/orders/sync with mocked graphql"
```

---

## Task 10: Read API — GET /api/fulfillment/orders

**Files:**
- Create: `src/app/api/fulfillment/orders/route.ts`

- [ ] **Step 1: Implement read endpoint**

Create `src/app/api/fulfillment/orders/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { ordersWithComputedPL } from '@/lib/repos/reports'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const supplierId = searchParams.get('supplierId') ?? undefined
  const pipelineStatus = searchParams.get('pipelineStatus') ?? undefined
  const projectId = searchParams.get('projectId') ?? undefined

  const orders = await ordersWithComputedPL({
    projectId,
    supplierId,
    pipelineStatus,
    dateFrom: dateFrom ? new Date(dateFrom + 'T00:00:00Z') : undefined,
    dateTo: dateTo ? new Date(dateTo + 'T23:59:59.999Z') : undefined,
    limit: 500,
  })

  return NextResponse.json({ orders, count: orders.length })
}
```

- [ ] **Step 2: TypeScript compile check**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```powershell
git add src/app/api/fulfillment/orders/route.ts
git commit -m "feat(api): GET /api/fulfillment/orders with computed P/L per order"
```

---

## Task 11: Aggregate API — GET /api/fulfillment/pl-summary

**Files:**
- Create: `src/app/api/fulfillment/pl-summary/route.ts`

- [ ] **Step 1: Implement aggregate endpoint**

Create `src/app/api/fulfillment/pl-summary/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { plSummary } from '@/lib/repos/reports'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const supplierId = searchParams.get('supplierId') ?? undefined
  const projectId = searchParams.get('projectId') ?? undefined

  const summary = await plSummary({
    projectId,
    supplierId,
    dateFrom: dateFrom ? new Date(dateFrom + 'T00:00:00Z') : undefined,
    dateTo: dateTo ? new Date(dateTo + 'T23:59:59.999Z') : undefined,
  })

  return NextResponse.json(summary)
}
```

- [ ] **Step 2: TypeScript compile check**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```powershell
git add src/app/api/fulfillment/pl-summary/route.ts
git commit -m "feat(api): GET /api/fulfillment/pl-summary aggregate stats"
```

---

## Task 12: Read API — GET /api/shopify/orders (raw DB read)

**Files:**
- Create: `src/app/api/shopify/orders/route.ts`

- [ ] **Step 1: Implement raw read**

Create `src/app/api/shopify/orders/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server'
import { listOrdersWithLines } from '@/lib/repos/orders'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10), 500)
  const projectId = searchParams.get('projectId') ?? undefined
  const orders = await listOrdersWithLines({ projectId, limit })
  return NextResponse.json({ orders, count: orders.length })
}
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```powershell
git add src/app/api/shopify/orders/route.ts
git commit -m "feat(api): GET /api/shopify/orders raw DB read"
```

---

## Task 13: Sidebar — add Orders entry

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Add Orders nav entry**

In `src/components/Sidebar.tsx`, find the line:
```typescript
  { type: 'child', href: '/finance/fulfillment', icon: 'local_shipping', label: 'Fulfillment' },
```

Insert immediately after it:
```typescript
  { type: 'child', href: '/orders', icon: 'receipt_long', label: 'Orders & P/L' },
```

- [ ] **Step 2: Verify role visibility**

Check `src/lib/roles.ts` to confirm `/orders` is reachable. If `visibleFor()` whitelists explicit paths, add `/orders` to allowed list. (Read the file first; if it allows any non-listed path by default, no change needed.)

- [ ] **Step 3: Commit**

```powershell
git add src/components/Sidebar.tsx src/lib/roles.ts
git commit -m "feat(sidebar): add Orders & P/L nav entry"
```

---

## Task 14: Minimal /orders dashboard page

**Files:**
- Create: `src/app/orders/page.tsx`

- [ ] **Step 1: Create minimal dashboard**

Create `src/app/orders/page.tsx`:
```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type OrderRow = {
  id: string
  shopifyOrderNumber: string
  customerName: string | null
  placedAt: string
  currency: string
  expectedPayout: number
  pipelineStatus: string
  defaultSupplier: { name: string } | null
  computed: { baseCost: number; shipping: number; profit: number; margin: number; hasUnmappedSku: boolean }
}

type Summary = {
  orderCount: number; revenue: number; cogs: number; shipping: number;
  profit: number; margin: number; avgProfit: number; unmappedCount: number
}

type ProjectItem = { id: string; name: string; shopifyStore: { shop: string } | null }

export default function OrdersPage() {
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [projectId, setProjectId] = useState<string>('')   // '' = all projects
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string>('')

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(data => setProjects(data.projects ?? data ?? []))
  }, [])

  const load = useCallback(async () => {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    const [oRes, sRes] = await Promise.all([
      fetch(`/api/fulfillment/orders${q}`).then(r => r.json()),
      fetch(`/api/fulfillment/pl-summary${q}`).then(r => r.json()),
    ])
    setOrders(oRes.orders ?? [])
    setSummary(sRes)
  }, [projectId])

  useEffect(() => { load() }, [load])

  const sync = async () => {
    const creds = JSON.parse(localStorage.getItem('shopify_credentials_v1') ?? '{}')
    if (!creds.shop || !creds.accessToken) {
      setSyncResult('Missing Shopify credentials. Connect in /setup first.')
      return
    }
    setSyncing(true); setSyncResult('Syncing...')
    try {
      const res = await fetch('/api/shopify/orders/sync', {
        method: 'POST',
        headers: {
          'x-shopify-shop-domain': creds.shop,
          'x-shopify-access-token': creds.accessToken,
        },
      })
      const body = await res.json()
      setSyncResult(`Synced ${body.totalSynced} orders (${body.withUnmappedSku} unmapped SKU).`)
      await load()
    } catch (e: any) {
      setSyncResult(`Error: ${e.message}`)
    } finally { setSyncing(false) }
  }

  const fmt = (n: number, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n)

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-center justify-between mb-lg gap-md">
          <h1 className="text-display-md">Orders & P/L</h1>
          <div className="flex items-center gap-sm">
            <select
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm"
            >
              <option value="">All projects</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.shopifyStore ? ` · ${p.shopifyStore.shop}` : ''}
                </option>
              ))}
            </select>
            <button
              onClick={sync}
              disabled={syncing}
              className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
        </div>
        {syncResult && <p className="mb-md text-body-sm text-on-surface-variant">{syncResult}</p>}

        {summary && (
          <div className="grid grid-cols-5 gap-md mb-lg">
            {[
              { label: 'Revenue', value: fmt(summary.revenue) },
              { label: 'COGS', value: fmt(summary.cogs + summary.shipping) },
              { label: 'Profit', value: fmt(summary.profit) },
              { label: 'Margin', value: `${summary.margin.toFixed(1)}%` },
              { label: 'Orders', value: String(summary.orderCount) },
            ].map(s => (
              <div key={s.label} className="bg-surface-container-lowest rounded-xl p-md shadow-card border border-outline-variant/20">
                <p className="text-label-sm text-on-surface-variant">{s.label}</p>
                <p className="text-stats-lg">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {summary && summary.unmappedCount > 0 && (
          <div className="bg-error/10 border border-error/30 rounded-lg p-md mb-md text-body-sm">
            ⚠ {summary.unmappedCount} order(s) có SKU thiếu mapping — profit có thể không chính xác.
          </div>
        )}

        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="px-md py-sm">Order #</th>
                <th className="px-md py-sm">Customer</th>
                <th className="px-md py-sm">Date</th>
                <th className="px-md py-sm">Supplier</th>
                <th className="px-md py-sm text-right">Payout</th>
                <th className="px-md py-sm text-right">COGS</th>
                <th className="px-md py-sm text-right">Ship</th>
                <th className="px-md py-sm text-right">Profit</th>
                <th className="px-md py-sm text-right">Margin</th>
                <th className="px-md py-sm">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id} className={`border-t border-outline-variant/20 ${o.computed.hasUnmappedSku ? 'bg-error/5' : ''}`}>
                  <td className="px-md py-sm font-mono">{o.shopifyOrderNumber}</td>
                  <td className="px-md py-sm">{o.customerName ?? '—'}</td>
                  <td className="px-md py-sm">{new Date(o.placedAt).toLocaleDateString('en-CA')}</td>
                  <td className="px-md py-sm">{o.defaultSupplier?.name ?? <span className="text-error">unmapped</span>}</td>
                  <td className="px-md py-sm text-right">{fmt(o.expectedPayout, o.currency)}</td>
                  <td className="px-md py-sm text-right">{fmt(o.computed.baseCost, o.currency)}</td>
                  <td className="px-md py-sm text-right">{fmt(o.computed.shipping, o.currency)}</td>
                  <td className={`px-md py-sm text-right font-semibold ${o.computed.profit >= 0 ? 'text-on-tertiary-container' : 'text-error'}`}>
                    {fmt(o.computed.profit, o.currency)}
                  </td>
                  <td className="px-md py-sm text-right">{o.computed.margin.toFixed(1)}%</td>
                  <td className="px-md py-sm">{o.pipelineStatus}</td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr><td colSpan={10} className="px-md py-lg text-center text-on-surface-variant">No orders yet. Click "Sync Now".</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Run dev server and smoke test**

Run:
```powershell
npm run dev -- --port 3002
```
Open http://localhost:3002/orders — should render empty table with "Sync Now" button.

- [ ] **Step 3: Manual sync test (if Shopify creds available)**

If user already has Shopify connected in `localStorage`, click "Sync Now" — should populate table with orders. If no creds, document this in NOTES.md as needing manual test.

- [ ] **Step 4: Commit**

```powershell
git add src/app/orders/page.tsx
git commit -m "feat(ui): minimal /orders dashboard with sync button + P/L table"
```

---

## Task 15: Update project docs

**Files:**
- Modify: `NOTES.md`, `PLAN.md`, `SPEC.md`, `CLAUDE.md`

- [ ] **Step 1: Update NOTES.md "Active Work" section**

In `NOTES.md`, replace the `## 🔥 Active Work — Phase 13 Fulfillment & POD (BRAINSTORMING)` block with:
```markdown
## 🔥 Active Work — Phase 13 Fulfillment & POD (IMPLEMENTATION IN PROGRESS)

**Spec:** [docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md](docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md)
**Plan 1 (this phase):** [docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md)

**Phase 13.1 + 13.2 status:** ✅ DONE
- 6 new Prisma models migrated (`Supplier`, `SupplierProduct`, `SupplierCostHistory`, `Order`, `OrderLine`, `CsvTemplate`) + `ShopifyStore.syncSinceDate`
- 3 pure libraries unit-tested: `pl-calculator`, `csv-template`, `timezone`
- `shopify-orders.ts` GraphQL client (2024-10, paginated)
- Sync route `POST /api/shopify/orders/sync` with snapshot-on-sync P/L
- Read APIs: `GET /api/shopify/orders`, `GET /api/fulfillment/orders`, `GET /api/fulfillment/pl-summary`
- Minimal `/orders` dashboard (sync button + stat cards + P/L table)
- Vitest framework added

**Next: Plan 2 — Supplier Setup UI + CSV Export (Phase 13.3 + 13.4 + 13.5)**
- `/setup/suppliers` CRUD UI
- `/setup/products` SKU mapping table with CSV import
- Printful / Printify connectors
- CSV template builder UI
- `/orders/export` page

**Then: Plan 3 — Pipeline + Alerts + Project integration (Phase 13.6 + 13.7)**

**Path note:** Spec uses `/fulfillment`, plan uses `/orders` because `/finance/fulfillment` already taken. Future plans follow `/orders/*`.
```

- [ ] **Step 2: Update PLAN.md Phase 13 status**

In `PLAN.md`, find the `### 🟡 Phase 13 — Fulfillment & Supplier POD (IN BRAINSTORMING)` heading and change to:
```markdown
### 🟢 Phase 13.1 + 13.2 — Fulfillment Foundation & Sync (DONE)
**Plan:** [docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md)

### 🔲 Phase 13.3 + 13.4 + 13.5 — Supplier Setup + CSV Export (TODO — Plan 2)
### 🔲 Phase 13.6 + 13.7 — Pipeline + Alerts + Project integration (TODO — Plan 3)
```

- [ ] **Step 3: Update SPEC.md database schema section**

In `SPEC.md`, append after the existing schema models (after the closing of `MetaBilling` model):
```prisma
// Phase 13 Fulfillment & POD models — see docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md
model Supplier { ... }            // see schema.prisma
model SupplierProduct { ... }
model SupplierCostHistory { ... }
model Order { ... }
model OrderLine { ... }
model CsvTemplate { ... }
```
(Reference only — full def lives in `prisma/schema.prisma`.)

Also update Navigation Structure section, add under FINANCE:
```
  └ Orders & P/L            /orders
```

- [ ] **Step 4: Commit**

```powershell
git add NOTES.md PLAN.md SPEC.md CLAUDE.md
git commit -m "docs: mark Phase 13.1+13.2 done, point to Plan 2 next"
```

---

## Final Verification Checklist

After all 15 tasks complete, run this sanity sweep:

- [ ] `npm test` — all 12+ unit tests + 1 integration test pass
- [ ] `npx tsc --noEmit` — 0 TypeScript errors
- [ ] `npx prisma migrate status` — no pending migrations
- [ ] `npm run dev` — server starts, `/orders` page renders, "Sync Now" button visible
- [ ] If Shopify creds available: click "Sync Now" → DB populates with orders → table updates → stat cards show non-zero values
- [ ] Git log shows ~12-15 small commits (one per task)
- [ ] `NOTES.md`, `PLAN.md` reflect new "DONE" status

---

## What's NOT in this plan (deferred)

- Cron / Vercel scheduled sync (manual button only for now)
- Printful / Printify API connectors (in Plan 2)
- Supplier setup UI (in Plan 2)
- SKU mapping CSV import (in Plan 2)
- CSV template builder + export (in Plan 2)
- Pipeline Kanban (in Plan 3)
- Alert panel UI (in Plan 3)
- Project module integration for combined P&L (in Plan 3)
- Order drill-down modal (in Plan 3)
- VN/US timezone toggle in date filter (in Plan 2 once basic dashboard ships)
