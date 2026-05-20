# Product Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a structured ProductBase mapping system that replaces heuristic auto-mapping, with an Auto Mapping tab (rule-based ProductBase rules) and a Manual Mapping tab (per-variant overrides with absolute priority).

**Architecture:** New `ProductBase` entity defines match conditions (Shopify productType + variant option name/value pairs). A priority chain resolver checks `VariantManualMapping` first, then `ProductBaseOverride`, then `ProductBaseSupplierMapping` by rank, and sets `PENDING_MAPPING` if nothing resolves. The new resolver plugs into the existing Shopify sync route alongside the existing heuristic resolver.

**Tech Stack:** Next.js 14 App Router, Prisma v7 + SQLite/LibSQL, Vitest, Tailwind CSS design tokens.

---

## File Map

**New files:**
- `src/lib/product-mapping.ts` — pure resolver logic (no DB), fully unit-testable
- `src/lib/repos/mapping.ts` — CRUD for ProductBase, mappings, overrides, manual mappings
- `src/app/api/fulfillment/mapping/product-bases/route.ts` — GET list, POST create
- `src/app/api/fulfillment/mapping/product-bases/[id]/route.ts` — PUT update, DELETE
- `src/app/api/fulfillment/mapping/manual/route.ts` — GET pending queue + saved, POST save manual mapping
- `src/app/api/fulfillment/mapping/manual/[id]/route.ts` — DELETE saved mapping
- `src/app/api/fulfillment/mapping/supplier-products/route.ts` — GET supplier products for dropdown
- `src/app/fulfillment/mapping/page.tsx` — UI page (2 tabs)
- `tests/product-mapping.test.ts` — unit tests for resolver

**Modified files:**
- `prisma/schema.prisma` — 4 new models + `shopifyVariantId`/`variantOptions` on OrderLine
- `src/lib/db.ts` — bump SCHEMA_VERSION v12 → v13
- `src/lib/pipeline-status.ts` — add PENDING_MAPPING status
- `src/lib/shopify-orders.ts` — add variantId + selectedOptions to GraphQL query + types
- `src/app/api/shopify/orders/sync/route.ts` — integrate new resolver, pass variantId + variantOptions
- `src/components/Sidebar.tsx` — update nav: rename existing entry + add new mapping entry

---

## Task 1: Add PENDING_MAPPING to Pipeline Status

**Files:**
- Modify: `src/lib/pipeline-status.ts`
- Modify: `tests/pipeline-status.test.ts`

- [ ] **Step 1: Update pipeline-status.ts**

```typescript
// src/lib/pipeline-status.ts
export const PIPELINE_STATUSES = [
  'PENDING_DESIGN',
  'PENDING_MAPPING',   // ← add here, after PENDING_DESIGN
  'PENDING',
  'EXPORTED',
  'ON_HOLD',
  'SUPPLIER_PROCESSING',
  'IN_PRODUCTION',
  'FULFILLED',
  'DESIGN_REJECTED',
  'ERROR',
  'CANCELLED',
  'REFUNDED',
] as const

export type PipelineStatus = typeof PIPELINE_STATUSES[number]

export const STATUS_LABELS: Record<PipelineStatus, string> = {
  PENDING_DESIGN: 'Pending Design',
  PENDING_MAPPING: 'Pending Mapping',   // ← add
  PENDING: 'Pending',
  EXPORTED: 'Exported',
  ON_HOLD: 'On Hold',
  SUPPLIER_PROCESSING: 'Supplier Processing',
  IN_PRODUCTION: 'In Production',
  FULFILLED: 'Fulfilled',
  DESIGN_REJECTED: 'Design Rejected',
  ERROR: 'Error',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
}

export const STATUS_COLORS: Record<PipelineStatus, string> = {
  PENDING_DESIGN: 'bg-amber-100 text-amber-900',
  PENDING_MAPPING: 'bg-rose-100 text-rose-900',   // ← add
  PENDING: 'bg-blue-100 text-blue-900',
  EXPORTED: 'bg-indigo-100 text-indigo-900',
  ON_HOLD: 'bg-gray-200 text-gray-900',
  SUPPLIER_PROCESSING: 'bg-cyan-100 text-cyan-900',
  IN_PRODUCTION: 'bg-purple-100 text-purple-900',
  FULFILLED: 'bg-green-100 text-green-900',
  DESIGN_REJECTED: 'bg-orange-100 text-orange-900',
  ERROR: 'bg-red-100 text-red-900',
  CANCELLED: 'bg-gray-300 text-gray-700',
  REFUNDED: 'bg-pink-100 text-pink-900',
}

const SYNC_RE_EVALUATED: PipelineStatus[] = ['PENDING_DESIGN', 'PENDING_MAPPING', 'PENDING']

export function isValidPipelineStatus(v: string): v is PipelineStatus {
  return (PIPELINE_STATUSES as readonly string[]).includes(v)
}

export type AutoDetectInput = {
  financialStatus: string
  hasUnmappedSku: boolean
  hasPendingMapping: boolean   // ← add: true when new resolver returns unresolved
  hasCustomDesignLine: boolean
  currentStatus?: PipelineStatus | null
}

export function autoDetectStatus(input: AutoDetectInput): PipelineStatus {
  const fs = (input.financialStatus || '').toUpperCase()

  if (fs.includes('REFUND')) return 'REFUNDED'
  if (fs === 'VOIDED' || fs === 'CANCELLED') return 'CANCELLED'

  // PENDING_MAPPING takes priority over PENDING_DESIGN
  const initial: PipelineStatus =
    input.hasPendingMapping ? 'PENDING_MAPPING' :
    input.hasUnmappedSku || input.hasCustomDesignLine ? 'PENDING_DESIGN' :
    'PENDING'

  if (!input.currentStatus) return initial
  if (SYNC_RE_EVALUATED.includes(input.currentStatus)) return initial
  return input.currentStatus
}
```

- [ ] **Step 2: Run existing pipeline-status tests**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx vitest run tests/pipeline-status.test.ts
```

Expected: all pass (existing tests don't test hasPendingMapping yet).

- [ ] **Step 3: Commit**

```bash
git add src/lib/pipeline-status.ts
git commit -m "feat: add PENDING_MAPPING pipeline status"
```

---

## Task 2: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/db.ts`

- [ ] **Step 1: Add 4 models + OrderLine fields to schema.prisma**

Add to the bottom of `prisma/schema.prisma` (before the last closing line):

```prisma
model ProductBase {
  id                 String   @id @default(cuid())
  name               String
  shopifyProductType String
  variantConditions  String   // JSON: [{optionName, value?|anyOf?}]
  notes              String?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  supplierMappings ProductBaseSupplierMapping[]
  overrides        ProductBaseOverride[]
  variantMappings  VariantManualMapping[]

  @@index([shopifyProductType])
}

model ProductBaseSupplierMapping {
  id                String          @id @default(cuid())
  productBaseId     String
  supplierProductId String
  preferenceRank    Int

  productBase     ProductBase     @relation(fields: [productBaseId], references: [id], onDelete: Cascade)
  supplierProduct SupplierProduct @relation(fields: [supplierProductId], references: [id], onDelete: Cascade)

  @@unique([productBaseId, preferenceRank])
  @@index([productBaseId])
}

model ProductBaseOverride {
  id                String          @id @default(cuid())
  productBaseId     String
  supplierProductId String
  attributeCombo    String          // JSON: {"Size":"6XL"}
  notes             String?

  productBase     ProductBase     @relation(fields: [productBaseId], references: [id], onDelete: Cascade)
  supplierProduct SupplierProduct @relation(fields: [supplierProductId], references: [id], onDelete: Cascade)

  @@index([productBaseId])
}

model VariantManualMapping {
  id                  String   @id @default(cuid())
  shopifyVariantId    String   @unique
  shopifyProductTitle String
  variantTitle        String?
  supplierProductId   String
  productBaseId       String?
  notes               String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  supplierProduct SupplierProduct @relation(fields: [supplierProductId], references: [id], onDelete: Cascade)
  productBase     ProductBase?    @relation(fields: [productBaseId], references: [id], onDelete: SetNull)

  @@index([shopifyVariantId])
}
```

Also update the `OrderLine` model — add 2 new fields after `shopifyLineId`:

```prisma
model OrderLine {
  id                      String    @id @default(cuid())
  orderId                 String
  order                   Order     @relation(fields: [orderId], references: [id], onDelete: Cascade)
  shopifyLineId           String
  shopifyVariantId        String?   // ← add
  variantOptions          String?   // ← add: JSON {"Style":"Tshirt","Size":"S"}
  sku                     String?
  resolvedSupplierSku     String?
  variantTitle            String?
  productTitle            String
  qty                     Int
  unitPrice               Float
  resolvedSupplierId      String?
  resolvedBaseCost        Float?
  costSnapshotAt          DateTime?
  resolvedShipFirst       Float?
  resolvedShipAdditional  Float?
  resolvedImportTax       Float?
  @@index([sku])
  @@index([shopifyVariantId])  // ← add
}
```

Also update `SupplierProduct` to add back-relations:

```prisma
// In model SupplierProduct, add these relations after existing ones:
  baseSupplierMappings  ProductBaseSupplierMapping[]
  baseOverrides         ProductBaseOverride[]
  variantManualMappings VariantManualMapping[]
```

- [ ] **Step 2: Run migration**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --name add_product_mapping
npx prisma generate
```

Expected: migration succeeds, new tables created.

- [ ] **Step 3: Bump SCHEMA_VERSION in src/lib/db.ts**

Change line 6:
```typescript
const SCHEMA_VERSION = 'v13'
```

- [ ] **Step 4: Commit**

```bash
git add prisma/ src/lib/db.ts
git commit -m "feat: add ProductBase mapping schema (4 models + OrderLine variantId/options)"
```

---

## Task 3: Core Resolver Logic + Tests

**Files:**
- Create: `src/lib/product-mapping.ts`
- Create: `tests/product-mapping.test.ts`

- [ ] **Step 1: Write failing tests first**

```typescript
// tests/product-mapping.test.ts
import { describe, expect, it } from 'vitest'
import {
  matchesProductBase,
  matchesAttributeCombo,
  resolveByProductBase,
  type ProductBaseData,
  type VariantManualMappingData,
} from '@/lib/product-mapping'

const tshirt3d: ProductBaseData = {
  id: 'pb1',
  shopifyProductType: '3D Clothing',
  variantConditions: JSON.stringify([
    { optionName: 'Style', value: 'Tshirt' },
    { optionName: 'Size', anyOf: ['S', 'M', 'L', 'XL'] },
  ]),
  supplierMappings: [
    { preferenceRank: 1, supplierProductId: 'sp_a' },
    { preferenceRank: 2, supplierProductId: 'sp_b' },
  ],
  overrides: [
    { attributeCombo: JSON.stringify({ Size: '6XL' }), supplierProductId: 'sp_b_oversized' },
  ],
}

describe('matchesProductBase', () => {
  it('returns true when all conditions match', () => {
    expect(matchesProductBase('3D Clothing', { Style: 'Tshirt', Size: 'S' }, tshirt3d)).toBe(true)
  })

  it('returns false when productType does not match', () => {
    expect(matchesProductBase('2D Clothing', { Style: 'Tshirt', Size: 'S' }, tshirt3d)).toBe(false)
  })

  it('returns false when a condition value is not in anyOf', () => {
    expect(matchesProductBase('3D Clothing', { Style: 'Tshirt', Size: '3XL' }, tshirt3d)).toBe(false)
  })

  it('returns false when a required option is missing from variantOptions', () => {
    expect(matchesProductBase('3D Clothing', { Style: 'Tshirt' }, tshirt3d)).toBe(false)
  })

  it('is case-insensitive for productType and values', () => {
    expect(matchesProductBase('3d clothing', { style: 'tshirt', size: 'M' }, tshirt3d)).toBe(true)
  })
})

describe('matchesAttributeCombo', () => {
  it('returns true when all combo keys match variantOptions', () => {
    expect(matchesAttributeCombo({ Size: '6XL' }, { Style: 'Tshirt', Size: '6XL' })).toBe(true)
  })

  it('returns false when a combo value does not match', () => {
    expect(matchesAttributeCombo({ Size: '6XL' }, { Style: 'Tshirt', Size: 'XL' })).toBe(false)
  })
})

describe('resolveByProductBase', () => {
  it('returns variant_manual when VariantManualMapping exists', () => {
    const manualMappings: VariantManualMappingData[] = [
      { shopifyVariantId: 'var_123', supplierProductId: 'sp_manual' },
    ]
    const result = resolveByProductBase('var_123', '3D Clothing', { Style: 'Tshirt', Size: 'S' }, [], manualMappings)
    expect(result).toEqual({ supplierProductId: 'sp_manual', resolvedVia: 'variant_manual' })
  })

  it('returns product_base_override when attributeCombo matches', () => {
    const result = resolveByProductBase(null, '3D Clothing', { Style: 'Tshirt', Size: '6XL' }, [tshirt3d], [])
    expect(result).toEqual({ supplierProductId: 'sp_b_oversized', resolvedVia: 'product_base_override' })
  })

  it('returns product_base_rank when no override matches', () => {
    const result = resolveByProductBase(null, '3D Clothing', { Style: 'Tshirt', Size: 'S' }, [tshirt3d], [])
    expect(result).toEqual({ supplierProductId: 'sp_a', resolvedVia: 'product_base_rank' })
  })

  it('returns unresolved when no ProductBase matches', () => {
    const result = resolveByProductBase(null, 'Unknown Type', { Style: 'Mug' }, [tshirt3d], [])
    expect(result).toEqual({ supplierProductId: null, resolvedVia: 'unresolved' })
  })

  it('variant_manual takes priority over product_base_override', () => {
    const manualMappings: VariantManualMappingData[] = [
      { shopifyVariantId: 'var_456', supplierProductId: 'sp_manual_override' },
    ]
    const result = resolveByProductBase('var_456', '3D Clothing', { Style: 'Tshirt', Size: '6XL' }, [tshirt3d], manualMappings)
    expect(result).toEqual({ supplierProductId: 'sp_manual_override', resolvedVia: 'variant_manual' })
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run tests/product-mapping.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/lib/product-mapping.ts**

```typescript
// src/lib/product-mapping.ts

export type VariantCondition = {
  optionName: string
  value?: string
  anyOf?: string[]
}

export type ProductBaseSupplierMappingData = {
  preferenceRank: number
  supplierProductId: string
}

export type ProductBaseOverrideData = {
  attributeCombo: string  // JSON
  supplierProductId: string
}

export type ProductBaseData = {
  id: string
  shopifyProductType: string
  variantConditions: string  // JSON
  supplierMappings: ProductBaseSupplierMappingData[]
  overrides: ProductBaseOverrideData[]
}

export type VariantManualMappingData = {
  shopifyVariantId: string
  supplierProductId: string
}

export type ResolveResult = {
  supplierProductId: string | null
  resolvedVia: 'variant_manual' | 'product_base_override' | 'product_base_rank' | 'unresolved'
}

function normalize(v: string): string {
  return v.toLowerCase().trim()
}

export function matchesProductBase(
  shopifyProductType: string,
  variantOptions: Record<string, string>,
  base: ProductBaseData,
): boolean {
  if (normalize(shopifyProductType) !== normalize(base.shopifyProductType)) return false
  let conditions: VariantCondition[]
  try {
    conditions = JSON.parse(base.variantConditions)
  } catch {
    return false
  }
  const normalizedOptions: Record<string, string> = {}
  for (const [k, v] of Object.entries(variantOptions)) {
    normalizedOptions[normalize(k)] = normalize(v)
  }
  return conditions.every(cond => {
    const optVal = normalizedOptions[normalize(cond.optionName)]
    if (optVal === undefined) return false
    if (cond.value !== undefined) return optVal === normalize(cond.value)
    if (cond.anyOf !== undefined) return cond.anyOf.map(normalize).includes(optVal)
    return false
  })
}

export function matchesAttributeCombo(
  combo: Record<string, string>,
  variantOptions: Record<string, string>,
): boolean {
  const normalizedOptions: Record<string, string> = {}
  for (const [k, v] of Object.entries(variantOptions)) {
    normalizedOptions[normalize(k)] = normalize(v)
  }
  return Object.entries(combo).every(([k, v]) => normalizedOptions[normalize(k)] === normalize(v))
}

export function resolveByProductBase(
  shopifyVariantId: string | null,
  shopifyProductType: string | null,
  variantOptions: Record<string, string>,
  productBases: ProductBaseData[],
  manualMappings: VariantManualMappingData[],
): ResolveResult {
  // Priority 1: VariantManualMapping
  if (shopifyVariantId) {
    const manual = manualMappings.find(m => m.shopifyVariantId === shopifyVariantId)
    if (manual) return { supplierProductId: manual.supplierProductId, resolvedVia: 'variant_manual' }
  }

  if (!shopifyProductType) return { supplierProductId: null, resolvedVia: 'unresolved' }

  // Find matching ProductBase
  const base = productBases.find(b => matchesProductBase(shopifyProductType, variantOptions, b))
  if (!base) return { supplierProductId: null, resolvedVia: 'unresolved' }

  // Priority 2: ProductBaseOverride
  for (const override of base.overrides) {
    let combo: Record<string, string>
    try {
      combo = JSON.parse(override.attributeCombo)
    } catch {
      continue
    }
    if (matchesAttributeCombo(combo, variantOptions)) {
      return { supplierProductId: override.supplierProductId, resolvedVia: 'product_base_override' }
    }
  }

  // Priority 3: Rank-ordered supplier mapping
  const sorted = [...base.supplierMappings].sort((a, b) => a.preferenceRank - b.preferenceRank)
  if (sorted.length > 0) {
    return { supplierProductId: sorted[0].supplierProductId, resolvedVia: 'product_base_rank' }
  }

  return { supplierProductId: null, resolvedVia: 'unresolved' }
}
```

- [ ] **Step 4: Run tests — all must pass**

```bash
npx vitest run tests/product-mapping.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/product-mapping.ts tests/product-mapping.test.ts
git commit -m "feat: add ProductBase resolver logic with unit tests"
```

---

## Task 4: Repo Layer

**Files:**
- Create: `src/lib/repos/mapping.ts`

- [ ] **Step 1: Create the repo**

```typescript
// src/lib/repos/mapping.ts
import { prisma } from '@/lib/db'
import type { ProductBaseData, VariantManualMappingData } from '@/lib/product-mapping'

// ── ProductBase ───────────────────────────────────────────

export async function listProductBases() {
  return prisma.productBase.findMany({
    orderBy: { name: 'asc' },
    include: {
      supplierMappings: {
        orderBy: { preferenceRank: 'asc' },
        include: { supplierProduct: { include: { supplier: { select: { id: true, name: true, code: true } } } } },
      },
      overrides: {
        include: { supplierProduct: { include: { supplier: { select: { id: true, name: true, code: true } } } } },
      },
      _count: { select: { variantMappings: true } },
    },
  })
}

export async function getProductBaseById(id: string) {
  return prisma.productBase.findUnique({
    where: { id },
    include: {
      supplierMappings: {
        orderBy: { preferenceRank: 'asc' },
        include: { supplierProduct: { include: { supplier: { select: { id: true, name: true, code: true } } } } },
      },
      overrides: {
        include: { supplierProduct: { include: { supplier: { select: { id: true, name: true, code: true } } } } },
      },
    },
  })
}

export type ProductBaseInput = {
  name: string
  shopifyProductType: string
  variantConditions: string  // JSON
  notes?: string | null
  supplierMappings: Array<{ supplierProductId: string; preferenceRank: number }>
  overrides: Array<{ supplierProductId: string; attributeCombo: string; notes?: string | null }>
}

export async function createProductBase(input: ProductBaseInput) {
  return prisma.productBase.create({
    data: {
      name: input.name,
      shopifyProductType: input.shopifyProductType,
      variantConditions: input.variantConditions,
      notes: input.notes ?? null,
      supplierMappings: {
        create: input.supplierMappings.map(m => ({
          supplierProductId: m.supplierProductId,
          preferenceRank: m.preferenceRank,
        })),
      },
      overrides: {
        create: input.overrides.map(o => ({
          supplierProductId: o.supplierProductId,
          attributeCombo: o.attributeCombo,
          notes: o.notes ?? null,
        })),
      },
    },
  })
}

export async function updateProductBase(id: string, input: ProductBaseInput) {
  return prisma.$transaction(async (tx) => {
    await tx.productBaseSupplierMapping.deleteMany({ where: { productBaseId: id } })
    await tx.productBaseOverride.deleteMany({ where: { productBaseId: id } })
    return tx.productBase.update({
      where: { id },
      data: {
        name: input.name,
        shopifyProductType: input.shopifyProductType,
        variantConditions: input.variantConditions,
        notes: input.notes ?? null,
        supplierMappings: {
          create: input.supplierMappings.map(m => ({
            supplierProductId: m.supplierProductId,
            preferenceRank: m.preferenceRank,
          })),
        },
        overrides: {
          create: input.overrides.map(o => ({
            supplierProductId: o.supplierProductId,
            attributeCombo: o.attributeCombo,
            notes: o.notes ?? null,
          })),
        },
      },
    })
  })
}

export async function deleteProductBase(id: string) {
  return prisma.productBase.delete({ where: { id } })
}

// ── Load all data for resolver (called during sync) ──────────────────────

export async function loadProductBasesForResolver(): Promise<ProductBaseData[]> {
  const bases = await prisma.productBase.findMany({
    include: {
      supplierMappings: { orderBy: { preferenceRank: 'asc' } },
      overrides: true,
    },
  })
  return bases.map(b => ({
    id: b.id,
    shopifyProductType: b.shopifyProductType,
    variantConditions: b.variantConditions,
    supplierMappings: b.supplierMappings.map(m => ({
      preferenceRank: m.preferenceRank,
      supplierProductId: m.supplierProductId,
    })),
    overrides: b.overrides.map(o => ({
      attributeCombo: o.attributeCombo,
      supplierProductId: o.supplierProductId,
    })),
  }))
}

export async function loadVariantManualMappingsForResolver(): Promise<VariantManualMappingData[]> {
  const mappings = await prisma.variantManualMapping.findMany()
  return mappings.map(m => ({
    shopifyVariantId: m.shopifyVariantId,
    supplierProductId: m.supplierProductId,
  }))
}

// ── Manual Mapping ────────────────────────────────────────

export async function getPendingMappingQueue() {
  // Returns one row per unique shopifyVariantId (null variantIds excluded)
  const lines = await prisma.orderLine.findMany({
    where: {
      order: { pipelineStatus: 'PENDING_MAPPING' },
      resolvedSupplierId: null,
      shopifyVariantId: { not: null },
    },
    include: {
      order: {
        select: {
          id: true,
          shopifyOrderNumber: true,
          pipelineStatus: true,
          projectId: true,
        },
      },
    },
    orderBy: { order: { placedAt: 'desc' } },
    take: 500,
  })
  // Deduplicate by shopifyVariantId, keeping first occurrence (most recent order)
  const seen = new Set<string>()
  return lines.filter(l => {
    if (!l.shopifyVariantId || seen.has(l.shopifyVariantId)) return false
    seen.add(l.shopifyVariantId)
    return true
  })
}

export async function listVariantManualMappings() {
  return prisma.variantManualMapping.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      supplierProduct: {
        include: { supplier: { select: { id: true, name: true, code: true } } },
      },
    },
  })
}

export type SaveManualMappingInput = {
  shopifyVariantId: string
  shopifyProductTitle: string
  variantTitle?: string | null
  supplierProductId: string
  productBaseId?: string | null
  notes?: string | null
}

export async function saveManualMapping(input: SaveManualMappingInput) {
  return prisma.$transaction(async (tx) => {
    const mapping = await tx.variantManualMapping.upsert({
      where: { shopifyVariantId: input.shopifyVariantId },
      create: {
        shopifyVariantId: input.shopifyVariantId,
        shopifyProductTitle: input.shopifyProductTitle,
        variantTitle: input.variantTitle ?? null,
        supplierProductId: input.supplierProductId,
        productBaseId: input.productBaseId ?? null,
        notes: input.notes ?? null,
      },
      update: {
        supplierProductId: input.supplierProductId,
        productBaseId: input.productBaseId ?? null,
        notes: input.notes ?? null,
      },
      include: {
        supplierProduct: {
          include: { supplier: { select: { id: true, name: true, code: true } } },
        },
      },
    })

    // Unblock all PENDING_MAPPING order lines with this variantId
    const affectedLines = await tx.orderLine.findMany({
      where: { shopifyVariantId: input.shopifyVariantId, resolvedSupplierId: null },
      select: { orderId: true },
    })
    const orderIds = [...new Set(affectedLines.map(l => l.orderId))]
    if (orderIds.length > 0) {
      // Update all affected orders to PENDING (re-evaluated on next sync; for now unblock)
      await tx.order.updateMany({
        where: { id: { in: orderIds }, pipelineStatus: 'PENDING_MAPPING' },
        data: { pipelineStatus: 'PENDING' },
      })
    }

    return mapping
  })
}

export async function deleteManualMapping(id: string) {
  return prisma.variantManualMapping.delete({ where: { id } })
}
```

- [ ] **Step 2: Verify project compiles**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx tsc --noEmit
```

Expected: no errors related to new file.

- [ ] **Step 3: Commit**

```bash
git add src/lib/repos/mapping.ts
git commit -m "feat: add mapping repo layer (ProductBase CRUD + manual mapping queue)"
```

---

## Task 5: API Routes

**Files:**
- Create: `src/app/api/fulfillment/mapping/product-bases/route.ts`
- Create: `src/app/api/fulfillment/mapping/product-bases/[id]/route.ts`
- Create: `src/app/api/fulfillment/mapping/manual/route.ts`
- Create: `src/app/api/fulfillment/mapping/manual/[id]/route.ts`
- Create: `src/app/api/fulfillment/mapping/supplier-products/route.ts`

- [ ] **Step 1: Product bases list + create**

```typescript
// src/app/api/fulfillment/mapping/product-bases/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { listProductBases, createProductBase } from '@/lib/repos/mapping'

export async function GET() {
  const bases = await listProductBases()
  return NextResponse.json({ bases })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.name || !body.shopifyProductType || !body.variantConditions) {
    return NextResponse.json({ error: 'name, shopifyProductType, variantConditions required' }, { status: 400 })
  }
  const base = await createProductBase({
    name: body.name,
    shopifyProductType: body.shopifyProductType,
    variantConditions: body.variantConditions,
    notes: body.notes ?? null,
    supplierMappings: body.supplierMappings ?? [],
    overrides: body.overrides ?? [],
  })
  return NextResponse.json({ base }, { status: 201 })
}
```

- [ ] **Step 2: Product base update + delete**

```typescript
// src/app/api/fulfillment/mapping/product-bases/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { updateProductBase, deleteProductBase } from '@/lib/repos/mapping'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  if (!body.name || !body.shopifyProductType || !body.variantConditions) {
    return NextResponse.json({ error: 'name, shopifyProductType, variantConditions required' }, { status: 400 })
  }
  const base = await updateProductBase(params.id, {
    name: body.name,
    shopifyProductType: body.shopifyProductType,
    variantConditions: body.variantConditions,
    notes: body.notes ?? null,
    supplierMappings: body.supplierMappings ?? [],
    overrides: body.overrides ?? [],
  })
  return NextResponse.json({ base })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteProductBase(params.id)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Manual mapping routes**

```typescript
// src/app/api/fulfillment/mapping/manual/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getPendingMappingQueue, listVariantManualMappings, saveManualMapping } from '@/lib/repos/mapping'

export async function GET() {
  const [pending, saved] = await Promise.all([
    getPendingMappingQueue(),
    listVariantManualMappings(),
  ])
  return NextResponse.json({ pending, saved })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.shopifyVariantId || !body.shopifyProductTitle || !body.supplierProductId) {
    return NextResponse.json({ error: 'shopifyVariantId, shopifyProductTitle, supplierProductId required' }, { status: 400 })
  }
  const mapping = await saveManualMapping({
    shopifyVariantId: body.shopifyVariantId,
    shopifyProductTitle: body.shopifyProductTitle,
    variantTitle: body.variantTitle ?? null,
    supplierProductId: body.supplierProductId,
    productBaseId: body.productBaseId ?? null,
    notes: body.notes ?? null,
  })
  return NextResponse.json({ mapping }, { status: 201 })
}
```

```typescript
// src/app/api/fulfillment/mapping/manual/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { deleteManualMapping } from '@/lib/repos/mapping'

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteManualMapping(params.id)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Supplier products dropdown**

```typescript
// src/app/api/fulfillment/mapping/supplier-products/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const products = await prisma.supplierProduct.findMany({
    orderBy: [{ supplier: { name: 'asc' } }, { productName: 'asc' }],
    include: { supplier: { select: { id: true, name: true, code: true } } },
  })
  return NextResponse.json({ products })
}
```

- [ ] **Step 5: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/fulfillment/mapping/
git commit -m "feat: add mapping API routes (product-bases, manual, supplier-products)"
```

---

## Task 6: Update Shopify Sync

**Files:**
- Modify: `src/lib/shopify-orders.ts`
- Modify: `src/app/api/shopify/orders/sync/route.ts`

- [ ] **Step 1: Add variantId + selectedOptions to shopify-orders.ts**

Update the `ShopifyOrderLine` type (add 2 fields):

```typescript
export type ShopifyOrderLine = {
  id: string
  variantId: string | null          // ← add
  selectedOptions: Record<string, string>  // ← add: {"Style":"Tshirt","Size":"S"}
  sku: string | null
  title: string
  variantTitle: string | null
  quantity: number
  unitPrice: number
  productTags: string[]
  productType: string | null
  customAttributes: Array<{ key: string; value: string }>
}
```

Update the GraphQL query — inside `lineItems(first: 50)` nodes, add `variant` field:

```graphql
lineItems(first: 50) {
  nodes {
    id sku title variantTitle quantity
    variant {
      id
      selectedOptions { name value }
    }
    originalUnitPriceSet { shopMoney { amount } }
    customAttributes { key value }
    product { tags productType }
  }
}
```

Update the line mapping in `fetchOrdersPage` where lines are built. Find the block that maps `nodes` to `ShopifyOrderLine` and add:

```typescript
variantId: item.variant?.id ?? null,
selectedOptions: Object.fromEntries(
  (item.variant?.selectedOptions ?? []).map((o: { name: string; value: string }) => [o.name, o.value])
),
```

- [ ] **Step 2: Update sync/route.ts to use new resolver**

Add imports at the top:

```typescript
import { resolveByProductBase } from '@/lib/product-mapping'
import { loadProductBasesForResolver, loadVariantManualMappingsForResolver } from '@/lib/repos/mapping'
```

Inside the `POST` handler, after loading `mappingCandidates`, add:

```typescript
const productBases = await loadProductBasesForResolver()
const manualMappings = await loadVariantManualMappingsForResolver()
```

Inside the order loop, after computing `resolvedLines`, add a parallel new-resolver pass. Replace the `resolvedLines` computation block:

```typescript
const resolvedLines = o.lines.map(l => ({
  line: l,
  mapping: resolveSupplierForOrderLine({
    sku: l.sku,
    title: l.title,
    variantTitle: l.variantTitle,
    productTags: l.productTags,
    productType: l.productType,
  }, mappingCandidates),
  pbResolve: resolveByProductBase(
    l.variantId,
    l.productType,
    l.selectedOptions,
    productBases,
    manualMappings,
  ),
}))
```

Add a helper to check if any line is PENDING_MAPPING (new resolver couldn't resolve):

```typescript
const hasPendingMapping = resolvedLines.some(r => r.pbResolve.resolvedVia === 'unresolved')
```

Update the `autoDetectStatus` call to include `hasPendingMapping`:

```typescript
const detected = autoDetectStatus({
  financialStatus: o.financialStatus,
  hasUnmappedSku: pl.hasUnmappedSku,
  hasPendingMapping,
  hasCustomDesignLine,
  currentStatus,
})
```

In `upsertOrderWithLines` lines array, add `shopifyVariantId` and `variantOptions` per line:

```typescript
lines: o.lines.map((l, idx) => {
  const resolved = pl.perLineCost[idx]
  return {
    shopifyLineId: l.id,
    shopifyVariantId: l.variantId,                        // ← add
    variantOptions: JSON.stringify(l.selectedOptions),    // ← add
    sku: l.sku,
    resolvedSupplierSku: resolved.resolvedSupplierId
      ? resolvedLines[idx]?.mapping.supplier?.sku ?? null
      : null,
    variantTitle: l.variantTitle,
    productTitle: l.title,
    qty: l.quantity,
    unitPrice: l.unitPrice,
    resolvedSupplierId: resolved.resolvedSupplierId,
    resolvedBaseCost: resolved.resolvedBaseCost,
    resolvedShipFirst: pl.resolvedShipFirst,
    resolvedShipAdditional: pl.resolvedShipAdditional,
    resolvedImportTax: pl.resolvedImportTaxPerUnit,
  }
}),
```

- [ ] **Step 3: Update upsertOrderWithLines in repos/orders.ts to accept new fields**

Find `UpsertOrderInput` type and add:

```typescript
lines: Array<{
  shopifyLineId: string
  shopifyVariantId?: string | null   // ← add
  variantOptions?: string | null     // ← add
  sku: string | null
  // ...rest unchanged
}>
```

Find the `orderLine.create` data block inside `upsertOrderWithLines` and add the new fields:

```typescript
shopifyVariantId: line.shopifyVariantId ?? null,
variantOptions: line.variantOptions ?? null,
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: all 57+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shopify-orders.ts src/app/api/shopify/orders/sync/route.ts src/lib/repos/orders.ts
git commit -m "feat: integrate ProductBase resolver into Shopify sync, add variantId/options to OrderLine"
```

---

## Task 7: UI Page

**Files:**
- Create: `src/app/fulfillment/mapping/page.tsx`

- [ ] **Step 1: Create the page**

```typescript
// src/app/fulfillment/mapping/page.tsx
'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

// ── Types ────────────────────────────────────────────────────
type SupplierProduct = {
  id: string; sku: string; productName: string | null; sizeLabel: string | null
  supplier: { id: string; name: string; code: string }
}

type SupplierMapping = {
  preferenceRank: number; supplierProductId: string
  supplierProduct: SupplierProduct
}

type Override = {
  id?: string; attributeCombo: string; supplierProductId: string; notes?: string | null
  supplierProduct?: SupplierProduct
}

type ProductBase = {
  id: string; name: string; shopifyProductType: string
  variantConditions: string; notes: string | null
  supplierMappings: SupplierMapping[]
  overrides: Override[]
  _count: { variantMappings: number }
}

type ConditionRow = { optionName: string; anyOf: string[] }

type PendingLine = {
  id: string; shopifyVariantId: string | null; sku: string | null
  productTitle: string; variantTitle: string | null
  order: { shopifyOrderNumber: string }
}

type SavedMapping = {
  id: string; shopifyVariantId: string; shopifyProductTitle: string
  variantTitle: string | null
  supplierProduct: SupplierProduct
}

// ── Tag Input ────────────────────────────────────────────────
function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('')
  function add(val: string) {
    const v = val.trim()
    if (v && !tags.includes(v)) onChange([...tags, v])
    setInput('')
  }
  return (
    <div className="flex flex-wrap gap-1 items-center border border-outline-variant/40 rounded-lg px-sm py-[6px] min-h-[38px] bg-surface-container-lowest">
      {tags.map(t => (
        <span key={t} className="flex items-center gap-1 bg-secondary/10 text-secondary px-sm py-[2px] rounded text-label-sm font-semibold">
          {t}
          <button onClick={() => onChange(tags.filter(x => x !== t))} className="text-secondary/50 hover:text-secondary text-xs">✕</button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[60px] outline-none text-body-sm bg-transparent"
        placeholder="Nhập rồi Enter…"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(input) } }}
        onBlur={() => { if (input.trim()) add(input) }}
      />
    </div>
  )
}

// ── Edit Modal ───────────────────────────────────────────────
function EditModal({
  base, supplierProducts, onSave, onClose,
}: {
  base: ProductBase | null
  supplierProducts: SupplierProduct[]
  onSave: (data: any) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(base?.name ?? '')
  const [productType, setProductType] = useState(base?.shopifyProductType ?? '')
  const [conditions, setConditions] = useState<ConditionRow[]>(() => {
    if (!base?.variantConditions) return [{ optionName: '', anyOf: [] }]
    try {
      const parsed = JSON.parse(base.variantConditions)
      return parsed.map((c: any) => ({ optionName: c.optionName, anyOf: c.anyOf ?? (c.value ? [c.value] : []) }))
    } catch { return [{ optionName: '', anyOf: [] }] }
  })
  const [supplierMappings, setSupplierMappings] = useState<Array<{ preferenceRank: number; supplierProductId: string }>>(
    base?.supplierMappings.map(m => ({ preferenceRank: m.preferenceRank, supplierProductId: m.supplierProductId })) ?? []
  )
  const [overrides, setOverrides] = useState<Array<{ attributeCombo: string; supplierProductId: string; attrKey: string; attrVal: string }>>(
    base?.overrides.map(o => {
      let attrKey = '', attrVal = ''
      try { const c = JSON.parse(o.attributeCombo); const k = Object.keys(c)[0]; attrKey = k; attrVal = c[k] } catch {}
      return { attributeCombo: o.attributeCombo, supplierProductId: o.supplierProductId, attrKey, attrVal }
    }) ?? []
  )
  const [saving, setSaving] = useState(false)

  function buildConditionsJson() {
    return JSON.stringify(conditions.filter(c => c.optionName && c.anyOf.length > 0).map(c => ({
      optionName: c.optionName,
      anyOf: c.anyOf,
    })))
  }

  async function handleSave() {
    if (!name || !productType) return
    setSaving(true)
    await onSave({
      name, shopifyProductType: productType,
      variantConditions: buildConditionsJson(),
      supplierMappings: supplierMappings.filter(m => m.supplierProductId),
      overrides: overrides.filter(o => o.supplierProductId && o.attrKey && o.attrVal).map(o => ({
        supplierProductId: o.supplierProductId,
        attributeCombo: JSON.stringify({ [o.attrKey]: o.attrVal }),
      })),
    })
    setSaving(false)
  }

  const spMap = new Map(supplierProducts.map(p => [p.id, p]))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-surface-container-lowest rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-xl py-md bg-primary rounded-t-xl">
          <h2 className="text-headline-sm text-on-primary font-bold">{base ? `Edit — ${base.name}` : 'New Product Base'}</h2>
          <button onClick={onClose} className="text-on-primary/50 hover:text-on-primary text-xl">✕</button>
        </div>

        <div className="p-xl flex flex-col gap-lg">
          {/* Basic info */}
          <div>
            <p className="text-label-sm font-semibold text-on-surface/50 uppercase tracking-widest mb-sm">Thông tin cơ bản</p>
            <div className="grid grid-cols-2 gap-md">
              <div>
                <label className="text-label-sm text-on-surface/60 mb-xs block">Tên Product Base</label>
                <input className="w-full border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div>
                <label className="text-label-sm text-on-surface/60 mb-xs block">Shopify Product Type</label>
                <input className="w-full border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm" value={productType} onChange={e => setProductType(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Conditions */}
          <div>
            <p className="text-label-sm font-semibold text-on-surface/50 uppercase tracking-widest mb-xs">Match Conditions <span className="font-normal normal-case text-on-surface/40">(AND logic)</span></p>
            <div className="flex flex-col gap-sm">
              {conditions.map((c, i) => (
                <div key={i} className="border border-outline-variant/30 rounded-lg p-md grid grid-cols-[130px_1fr_32px] gap-md items-start">
                  <div>
                    <label className="text-label-sm text-on-surface/50 mb-xs block">Option Name</label>
                    <input className="w-full border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm" value={c.optionName} onChange={e => setConditions(prev => prev.map((r, j) => j === i ? { ...r, optionName: e.target.value } : r))} placeholder="Style, Size…" />
                  </div>
                  <div>
                    <label className="text-label-sm text-on-surface/50 mb-xs block">Values <span className="text-on-surface/30 font-normal">(Enter để thêm)</span></label>
                    <TagInput tags={c.anyOf} onChange={tags => setConditions(prev => prev.map((r, j) => j === i ? { ...r, anyOf: tags } : r))} />
                  </div>
                  <button onClick={() => setConditions(prev => prev.filter((_, j) => j !== i))} className="text-error hover:text-error/80 text-lg mt-5">✕</button>
                </div>
              ))}
              <button onClick={() => setConditions(prev => [...prev, { optionName: '', anyOf: [] }])} className="text-secondary text-label-sm self-start hover:underline">+ Add condition</button>
            </div>
          </div>

          {/* Supplier mappings */}
          <div>
            <p className="text-label-sm font-semibold text-on-surface/50 uppercase tracking-widest mb-xs">Suppliers theo Rank</p>
            <div className="flex flex-col gap-sm">
              {supplierMappings.map((m, i) => {
                const sp = spMap.get(m.supplierProductId)
                return (
                  <div key={i} className="grid grid-cols-[40px_1fr_32px] gap-sm items-center">
                    <span className={`text-center rounded-lg py-[6px] text-label-sm font-bold ${i === 0 ? 'bg-secondary text-on-secondary' : 'bg-secondary/10 text-secondary'}`}>#{i + 1}</span>
                    <select className="border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm bg-surface-container-lowest" value={m.supplierProductId} onChange={e => setSupplierMappings(prev => prev.map((r, j) => j === i ? { ...r, supplierProductId: e.target.value, preferenceRank: j + 1 } : r))}>
                      <option value="">-- Chọn supplier product --</option>
                      {supplierProducts.map(p => (
                        <option key={p.id} value={p.id}>{p.productName ?? p.sku} — {p.supplier.name} · {p.sku}{p.sizeLabel ? ` · ${p.sizeLabel}` : ''}</option>
                      ))}
                    </select>
                    <button onClick={() => setSupplierMappings(prev => prev.filter((_, j) => j !== i).map((r, j) => ({ ...r, preferenceRank: j + 1 })))} className="text-error text-lg">✕</button>
                  </div>
                )
              })}
              <button onClick={() => setSupplierMappings(prev => [...prev, { preferenceRank: prev.length + 1, supplierProductId: '' }])} className="text-secondary text-label-sm self-start hover:underline">+ Add supplier product</button>
            </div>
          </div>

          {/* Special cases */}
          <div>
            <p className="text-label-sm font-semibold text-on-surface/50 uppercase tracking-widest mb-xs">Special Cases</p>
            <p className="text-body-sm text-on-surface/40 mb-sm">Ngoại lệ cho attribute combo cụ thể</p>
            <div className="flex flex-col gap-sm">
              {overrides.map((o, i) => (
                <div key={i} className="bg-[#fff8e1] border border-[#ffe082] rounded-lg p-md grid grid-cols-[1fr_1fr_32px] gap-md items-end">
                  <div>
                    <label className="text-label-sm text-on-surface/50 mb-xs block">Khi <span className="text-on-surface/30">(key = value)</span></label>
                    <div className="flex gap-sm">
                      <input className="flex-1 border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm" value={o.attrKey} onChange={e => setOverrides(prev => prev.map((r, j) => j === i ? { ...r, attrKey: e.target.value } : r))} placeholder="Size" />
                      <input className="flex-1 border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm" value={o.attrVal} onChange={e => setOverrides(prev => prev.map((r, j) => j === i ? { ...r, attrVal: e.target.value } : r))} placeholder="6XL" />
                    </div>
                  </div>
                  <div>
                    <label className="text-label-sm text-on-surface/50 mb-xs block">Dùng supplier product</label>
                    <select className="w-full border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm bg-white" value={o.supplierProductId} onChange={e => setOverrides(prev => prev.map((r, j) => j === i ? { ...r, supplierProductId: e.target.value } : r))}>
                      <option value="">-- Chọn --</option>
                      {supplierProducts.map(p => (
                        <option key={p.id} value={p.id}>{p.productName ?? p.sku} — {p.supplier.name}</option>
                      ))}
                    </select>
                  </div>
                  <button onClick={() => setOverrides(prev => prev.filter((_, j) => j !== i))} className="text-error text-lg mb-[2px]">✕</button>
                </div>
              ))}
              <button onClick={() => setOverrides(prev => [...prev, { attributeCombo: '', supplierProductId: '', attrKey: '', attrVal: '' }])} className="text-secondary text-label-sm self-start hover:underline">+ Add special case</button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-md px-xl py-md border-t border-outline-variant/20 bg-surface-container-low rounded-b-xl">
          <button onClick={onClose} className="px-lg py-sm rounded-lg border border-outline-variant/40 text-label-md text-on-surface/60">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Product Base'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────
export default function MappingPage() {
  const [tab, setTab] = useState<'auto' | 'manual'>('auto')
  const [bases, setBases] = useState<ProductBase[]>([])
  const [supplierProducts, setSupplierProducts] = useState<SupplierProduct[]>([])
  const [pendingLines, setPendingLines] = useState<PendingLine[]>([])
  const [savedMappings, setSavedMappings] = useState<SavedMapping[]>([])
  const [manualSubTab, setManualSubTab] = useState<'pending' | 'saved'>('pending')
  const [editBase, setEditBase] = useState<ProductBase | null | undefined>(undefined) // undefined = closed, null = new
  const [pendingAssign, setPendingAssign] = useState<Record<string, string>>({}) // variantId → supplierProductId
  const [saving, setSaving] = useState<string | null>(null)

  async function loadData() {
    const [basesRes, spRes, manualRes] = await Promise.all([
      fetch('/api/fulfillment/mapping/product-bases').then(r => r.json()),
      fetch('/api/fulfillment/mapping/supplier-products').then(r => r.json()),
      fetch('/api/fulfillment/mapping/manual').then(r => r.json()),
    ])
    setBases(basesRes.bases ?? [])
    setSupplierProducts(spRes.products ?? [])
    setPendingLines(manualRes.pending ?? [])
    setSavedMappings(manualRes.saved ?? [])
  }

  useEffect(() => { loadData() }, [])

  async function handleSaveBase(data: any) {
    if (editBase === null) {
      await fetch('/api/fulfillment/mapping/product-bases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    } else if (editBase) {
      await fetch(`/api/fulfillment/mapping/product-bases/${editBase.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    }
    setEditBase(undefined)
    loadData()
  }

  async function handleDeleteBase(id: string) {
    if (!confirm('Xóa Product Base này?')) return
    await fetch(`/api/fulfillment/mapping/product-bases/${id}`, { method: 'DELETE' })
    loadData()
  }

  async function handleSaveManual(line: PendingLine) {
    const spId = pendingAssign[line.shopifyVariantId ?? line.id]
    if (!spId || !line.shopifyVariantId) return
    setSaving(line.id)
    await fetch('/api/fulfillment/mapping/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopifyVariantId: line.shopifyVariantId,
        shopifyProductTitle: line.productTitle,
        variantTitle: line.variantTitle,
        supplierProductId: spId,
      }),
    })
    setSaving(null)
    loadData()
  }

  async function handleDeleteManual(id: string) {
    await fetch(`/api/fulfillment/mapping/manual/${id}`, { method: 'DELETE' })
    loadData()
  }

  const pendingCount = pendingLines.length

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-xl py-md border-b border-outline-variant/20">
            <div>
              <h1 className="text-headline-sm font-bold text-on-surface">Product Mapping</h1>
              <p className="text-body-sm text-on-surface/50 mt-xs">Cấu hình tự động khớp sản phẩm với supplier</p>
            </div>
            {tab === 'auto' && (
              <button onClick={() => setEditBase(null)} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
                + New Product Base
              </button>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b-2 border-outline-variant/20 bg-surface-container-low">
            <button onClick={() => setTab('auto')} className={`px-xl py-md text-label-md font-semibold transition-colors border-b-2 -mb-[2px] ${tab === 'auto' ? 'text-secondary border-secondary' : 'text-on-surface/50 border-transparent hover:text-on-surface'}`}>
              Auto Mapping
            </button>
            <button onClick={() => setTab('manual')} className={`px-xl py-md text-label-md font-semibold transition-colors border-b-2 -mb-[2px] flex items-center gap-sm ${tab === 'manual' ? 'text-error border-error' : 'text-on-surface/50 border-transparent hover:text-on-surface'}`}>
              Manual Mapping
              {pendingCount > 0 && <span className="bg-error text-white rounded-full px-sm py-[1px] text-[11px] font-bold">{pendingCount}</span>}
            </button>
          </div>

          {/* AUTO TAB */}
          {tab === 'auto' && (
            <div className="p-xl">
              <div className="border border-outline-variant/20 rounded-xl overflow-hidden">
                <div className="grid grid-cols-[2fr_2.5fr_2.5fr_1.2fr_80px] gap-md px-lg py-sm bg-surface-container-low text-label-sm font-semibold text-on-surface/50 uppercase tracking-wide">
                  <span>Product Base</span><span>Match Conditions</span><span>Suppliers</span><span>Special Cases</span><span></span>
                </div>
                {bases.length === 0 && (
                  <div className="px-lg py-xl text-center text-on-surface/40 text-body-sm">Chưa có Product Base nào. Nhấn "+ New" để tạo.</div>
                )}
                {bases.map((b, i) => {
                  let conditions: ConditionRow[] = []
                  try { conditions = JSON.parse(b.variantConditions) } catch {}
                  return (
                    <div key={b.id} className={`grid grid-cols-[2fr_2.5fr_2.5fr_1.2fr_80px] gap-md px-lg py-md items-center border-t border-outline-variant/10 ${i % 2 === 1 ? 'bg-surface-container-lowest' : ''}`}>
                      <div>
                        <p className="text-label-md font-bold text-on-surface">{b.name}</p>
                        <p className="text-body-sm text-on-surface/40 mt-[2px]">{b.shopifyProductType}</p>
                      </div>
                      <div className="flex flex-wrap gap-xs">
                        {conditions.map((c, ci) => (
                          <span key={ci} className="bg-secondary/10 text-secondary px-sm py-[2px] rounded text-label-sm font-semibold">
                            {c.optionName} = {(c.anyOf ?? []).join(', ')}
                          </span>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-xs">
                        {b.supplierMappings.map((m, mi) => (
                          <span key={m.supplierProductId} className={`px-sm py-[2px] rounded text-label-sm font-semibold ${mi === 0 ? 'bg-tertiary/10 text-tertiary' : 'bg-blue-100 text-blue-800'}`}>
                            #{m.preferenceRank} {m.supplierProduct.supplier.name}
                          </span>
                        ))}
                      </div>
                      <div>
                        {b.overrides.length > 0
                          ? <span className="bg-amber-100 text-amber-800 px-sm py-[2px] rounded text-label-sm font-semibold">{b.overrides.length} case{b.overrides.length > 1 ? 's' : ''}</span>
                          : <span className="text-on-surface/30 text-body-sm">—</span>}
                      </div>
                      <div className="flex gap-md justify-end">
                        <button onClick={() => setEditBase(b)} className="text-secondary text-label-sm font-semibold hover:underline">Edit</button>
                        <button onClick={() => handleDeleteBase(b.id)} className="text-error text-label-sm font-semibold hover:underline">Del</button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="mt-md p-md bg-secondary/5 rounded-lg text-body-sm text-on-surface/50 flex gap-xl flex-wrap">
                <span>🔵 Conditions match → auto assign supplier theo rank</span>
                <span>🟠 Special Cases = ngoại lệ attribute combo</span>
                <span>🔴 Manual Mapping tab = override tuyệt đối, priority 1</span>
              </div>
            </div>
          )}

          {/* MANUAL TAB */}
          {tab === 'manual' && (
            <div className="p-xl">
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-lg py-md mb-lg flex items-start gap-sm text-body-sm text-amber-900">
                <span className="text-lg">⚡</span>
                <span>Mapping ở đây <strong>override tất cả Auto Mapping rules</strong> và được dùng làm priority 1 cho mọi order về sau có cùng variant.</span>
              </div>

              <div className="flex gap-xs mb-lg border border-outline-variant/20 rounded-lg overflow-hidden w-fit">
                <button onClick={() => setManualSubTab('pending')} className={`px-lg py-sm text-label-md font-semibold flex items-center gap-sm ${manualSubTab === 'pending' ? 'bg-error text-white' : 'bg-surface-container-lowest text-on-surface/60'}`}>
                  Pending
                  {pendingCount > 0 && <span className={`rounded-full px-sm py-[1px] text-[11px] font-bold ${manualSubTab === 'pending' ? 'bg-white/30 text-white' : 'bg-error text-white'}`}>{pendingCount}</span>}
                </button>
                <button onClick={() => setManualSubTab('saved')} className={`px-lg py-sm text-label-md font-semibold flex items-center gap-sm border-l border-outline-variant/20 ${manualSubTab === 'saved' ? 'bg-secondary text-on-secondary' : 'bg-surface-container-lowest text-on-surface/60'}`}>
                  Saved Mappings
                  <span className={`rounded-full px-sm py-[1px] text-[11px] font-bold ${manualSubTab === 'saved' ? 'bg-white/20 text-white' : 'bg-secondary/10 text-secondary'}`}>{savedMappings.length}</span>
                </button>
              </div>

              {/* Pending sub-tab */}
              {manualSubTab === 'pending' && (
                <div className="border border-outline-variant/20 rounded-xl overflow-hidden">
                  <div className="grid grid-cols-[2.5fr_1.5fr_1fr_2fr_100px] gap-md px-lg py-sm bg-surface-container-low text-label-sm font-semibold text-on-surface/50 uppercase tracking-wide">
                    <span>Product / Variant</span><span>SKU</span><span>Blocked</span><span>Assign Supplier SKU</span><span></span>
                  </div>
                  {pendingLines.length === 0 && (
                    <div className="px-lg py-xl text-center text-on-surface/40 text-body-sm">Không có order nào đang bị blocked. ✅</div>
                  )}
                  {pendingLines.map(line => (
                    <div key={line.id} className="grid grid-cols-[2.5fr_1.5fr_1fr_2fr_100px] gap-md px-lg py-md items-center border-t border-outline-variant/10">
                      <div>
                        <p className="text-label-md font-semibold text-on-surface">{line.productTitle}</p>
                        <p className="text-body-sm text-on-surface/40">{line.variantTitle}</p>
                        <p className="text-body-sm text-on-surface/30">#{line.order.shopifyOrderNumber}</p>
                      </div>
                      <span className="font-mono text-body-sm text-on-surface/60">{line.sku ?? '—'}</span>
                      <span className="text-error text-label-sm font-semibold">blocked</span>
                      <select
                        className="border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm bg-surface-container-lowest"
                        value={pendingAssign[line.shopifyVariantId ?? line.id] ?? ''}
                        onChange={e => setPendingAssign(prev => ({ ...prev, [line.shopifyVariantId ?? line.id]: e.target.value }))}
                      >
                        <option value="">-- Chọn supplier SKU --</option>
                        {supplierProducts.map(p => (
                          <option key={p.id} value={p.id}>{p.productName ?? p.sku} — {p.supplier.name} · {p.sku}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleSaveManual(line)}
                        disabled={!pendingAssign[line.shopifyVariantId ?? line.id] || saving === line.id}
                        className="bg-secondary text-on-secondary px-md py-sm rounded-lg text-label-sm font-semibold disabled:opacity-40"
                      >
                        {saving === line.id ? '…' : 'Save'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Saved sub-tab */}
              {manualSubTab === 'saved' && (
                <div className="border border-outline-variant/20 rounded-xl overflow-hidden">
                  <div className="grid grid-cols-[2.5fr_2fr_80px] gap-md px-lg py-sm bg-surface-container-low text-label-sm font-semibold text-on-surface/50 uppercase tracking-wide">
                    <span>Product / Variant</span><span>Mapped Supplier Product</span><span></span>
                  </div>
                  {savedMappings.length === 0 && (
                    <div className="px-lg py-xl text-center text-on-surface/40 text-body-sm">Chưa có mapping nào được lưu.</div>
                  )}
                  {savedMappings.map(m => (
                    <div key={m.id} className="grid grid-cols-[2.5fr_2fr_80px] gap-md px-lg py-md items-center border-t border-outline-variant/10">
                      <div>
                        <p className="text-label-md font-semibold text-on-surface">{m.shopifyProductTitle}</p>
                        <p className="text-body-sm text-on-surface/40">{m.variantTitle}</p>
                        <p className="font-mono text-body-sm text-on-surface/30">{m.shopifyVariantId}</p>
                      </div>
                      <div>
                        <p className="text-label-md font-semibold text-on-surface">{m.supplierProduct.productName ?? m.supplierProduct.sku}</p>
                        <p className="text-body-sm text-on-surface/50">{m.supplierProduct.supplier.name} · {m.supplierProduct.sku}</p>
                      </div>
                      <div className="flex justify-end">
                        <button onClick={() => handleDeleteManual(m.id)} className="text-error text-label-sm font-semibold hover:underline">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Edit Modal */}
      {editBase !== undefined && (
        <EditModal
          base={editBase}
          supplierProducts={supplierProducts}
          onSave={handleSaveBase}
          onClose={() => setEditBase(undefined)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/fulfillment/mapping/
git commit -m "feat: add Product Mapping UI page with Auto/Manual tabs and Edit modal"
```

---

## Task 8: Update Sidebar

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Update nav entries**

In `src/components/Sidebar.tsx`, find the existing `Product Mapping` entry and update it:

```typescript
// Change this:
{ type: 'child', href: '/fulfillment/products', icon: 'inventory_2', label: 'Product Mapping' },

// To these two lines:
{ type: 'child', href: '/fulfillment/products', icon: 'inventory_2', label: 'Supplier Products' },
{ type: 'child', href: '/fulfillment/mapping', icon: 'account_tree', label: 'Product Mapping' },
```

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 3: Start dev server and verify**

```bash
npm run dev -- --port 3002
```

- Navigate to http://localhost:3002/fulfillment/mapping
- Verify both tabs load, edit modal opens, tag input works
- Verify sidebar shows both "Supplier Products" and "Product Mapping"

- [ ] **Step 4: Final commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: update sidebar — add Product Mapping nav entry"
```
