# Supplier Product Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `printingMethod`/`sizeLabel` from the supplier product schema and UI, replace with flexible `variant1Name/Value`/`variant2Name/Value` fields, and redesign the supplier detail page to a stacked full-width layout with inline expandable rows instead of an Edit link.

**Architecture:** Backend changes flow from schema → repo types → API route → auto-mapping. Frontend changes replace both supplier detail page (stacked import bar + expandable-row table) and the products page (updated columns + edit modal). All seven changes are made in order so each compiles before the next layer builds on it.

**Tech Stack:** Prisma + LibSQL/SQLite, Next.js 14 App Router (`'use client'`), Vitest, TypeScript

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `prisma/schema.prisma` | Remove 2 old fields, add 4 variant fields |
| Modify | `src/lib/db.ts` | Bump SCHEMA_VERSION v13 → v14 |
| Modify | `src/lib/auto-mapping.ts` | Update `SupplierProductCandidate` type + scoring logic |
| Modify | `src/lib/repos/suppliers.ts` | Update `ProductUpsertInput`, `ProductBulkRow`, `buildSupplierProductCandidates`, `upsertProductMapping` |
| Modify | `src/app/api/suppliers/products/[id]/route.ts` | Update PATCH handler |
| Modify | `tests/auto-mapping.test.ts` | Update mock data — remove old fields, add variant fields |
| Modify | `src/app/setup/suppliers/[id]/page.tsx` | Full UI redesign — stacked import + expandable table |
| Modify | `src/app/setup/products/page.tsx` | Update columns, edit modal, CSV parsing |

---

## Task 1: Schema Migration + Version Bump

**Files:**
- Modify: `prisma/schema.prisma` (lines 315–316 for old fields, after line 320 for new)
- Modify: `src/lib/db.ts` (line 6)

- [ ] **Step 1.1: Edit schema.prisma — remove old fields, add 4 variant fields**

In `prisma/schema.prisma`, in `model SupplierProduct` (around line 302), replace the two old fields with four new ones:

```prisma
// REMOVE these two lines:
  printingMethod      String?
  sizeLabel           String?

// ADD these four lines in their place (before designTemplateUrl):
  variant1Name        String?
  variant1Value       String?
  variant2Name        String?
  variant2Value       String?
```

The resulting block around line 313–321 should look like:

```prisma
  baseSku             String?
  productType         String?
  variant1Name        String?
  variant1Value       String?
  variant2Name        String?
  variant2Value       String?
  designTemplateUrl   String?
  minProductionDays   Int?
  maxProductionDays   Int?
  shippingByRegion    String?
```

- [ ] **Step 1.2: Generate migration without applying it**

```powershell
cd "C:\Users\TM PC\Desktop\Ecom manager\ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --create-only --name add-variants-remove-old-fields
```

Expected: Prisma creates a new file in `prisma/migrations/YYYYMMDDHHMMSS_add_variants_remove_old_fields/migration.sql`

- [ ] **Step 1.3: Edit the generated migration.sql to include sizeLabel data migration**

Open the generated `migration.sql`. Find the `INSERT INTO "new_SupplierProduct"` statement and add the data-migration columns.

The migration Prisma generates for SQLite column removal recreates the table like this:

```sql
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SupplierProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    ...
    "variant1Name" TEXT,
    "variant1Value" TEXT,
    "variant2Name" TEXT,
    "variant2Value" TEXT,
    ...
    CONSTRAINT "SupplierProduct_supplierId_fkey" ...
);
INSERT INTO "new_SupplierProduct" (..., "variant1Name", "variant1Value", "variant2Name", "variant2Value", ...)
    SELECT ..., NULL, "sizeLabel", NULL, NULL, ...
    FROM "SupplierProduct";
```

If Prisma generates `NULL, NULL, NULL, NULL` for the variant columns in the SELECT, manually change it to migrate `sizeLabel`:

Find the INSERT/SELECT block and change the SELECT to include:
```sql
    CASE WHEN "sizeLabel" IS NOT NULL AND "sizeLabel" != '' THEN 'Size' ELSE NULL END,
    "sizeLabel",
    NULL,
    NULL,
```
in the positions corresponding to `variant1Name`, `variant1Value`, `variant2Name`, `variant2Value`.

If Prisma already includes the correct columns (it may auto-map by name — `sizeLabel` won't map to `variant1Value` automatically), make sure this data migration is present.

> **Note:** If you're unsure about the exact generated SQL, run `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` to preview first.

- [ ] **Step 1.4: Apply the migration**

```powershell
npx prisma migrate dev
```

Expected output: `The following migration(s) have been applied: add_variants_remove_old_fields`

- [ ] **Step 1.5: Regenerate Prisma client**

```powershell
npx prisma generate
```

Expected: Generated to `src/generated/prisma/client`

- [ ] **Step 1.6: Edit src/lib/db.ts — bump SCHEMA_VERSION**

In `src/lib/db.ts` line 6, change:
```typescript
const SCHEMA_VERSION = 'v13' // bump this to force singleton reset after schema changes
```
to:
```typescript
const SCHEMA_VERSION = 'v14' // bump this to force singleton reset after schema changes
```

- [ ] **Step 1.7: Commit**

```powershell
git add prisma/schema.prisma prisma/migrations/ src/lib/db.ts src/generated/
git commit -m "feat: replace printingMethod+sizeLabel with variant1/2 Name/Value fields"
```

---

## Task 2: Auto-Mapping Types + Scoring Logic + Repo Layer

**Files:**
- Modify: `src/lib/auto-mapping.ts`
- Modify: `src/lib/repos/suppliers.ts`

- [ ] **Step 2.1: Write failing test to verify variant scoring in auto-mapping**

In `tests/auto-mapping.test.ts`, ADD this test (leave existing tests untouched for now — they'll be fixed in Task 3):

```typescript
it('scores variant1Value and variant2Value match against order line', () => {
  const candidates: SupplierProductCandidate[] = [
    {
      ...base,
      sku: 'MUG-10OZ',
      supplierId: 'sup_mug',
      baseCost: 6,
      productType: 'Mug',
      productName: 'White Mug',
      variant1Name: 'Capacity',
      variant1Value: '10oz',
      variant2Name: null,
      variant2Value: null,
    },
    {
      ...base,
      sku: 'MUG-15OZ',
      supplierId: 'sup_mug2',
      baseCost: 7,
      productType: 'Mug',
      productName: 'White Mug',
      variant1Name: 'Capacity',
      variant1Value: '15oz',
      variant2Name: null,
      variant2Value: null,
    },
  ]

  const result = resolveSupplierForOrderLine({
    sku: 'DESIGN-MUG-001',
    title: 'White Mug 10oz',
    variantTitle: '10oz',
    productTags: [],
  }, candidates)

  expect(result.supplier?.supplierId).toBe('sup_mug')
  expect(result.reasons).toContain('variant')
})
```

- [ ] **Step 2.2: Run the failing test**

```powershell
npx vitest run tests/auto-mapping.test.ts
```

Expected: FAIL — `variant1Value` / `variant2Value` not in `SupplierProductCandidate` type yet, and no `variant` reason.

- [ ] **Step 2.3: Update SupplierProductCandidate type in auto-mapping.ts**

In `src/lib/auto-mapping.ts`, replace the type (lines 3–12):

```typescript
export type SupplierProductCandidate = SupplierInput & {
  sku: string
  supplierName: string
  supplierCode: string
  supplierPreferenceRank: number
  productName?: string | null
  productType?: string | null
  variant1Name?: string | null
  variant1Value?: string | null
  variant2Name?: string | null
  variant2Value?: string | null
}
```

- [ ] **Step 2.4: Update scoring logic in resolveSupplierForOrderLine**

In `src/lib/auto-mapping.ts`, make these three changes inside the `for (const c of candidates)` loop:

**Change 1:** candidateDesignKind — remove `c.printingMethod` (line 79):
```typescript
// OLD:
const candidateDesignKind = detectDesignKind([c.printingMethod, c.productType, c.productName])
// NEW:
const candidateDesignKind = detectDesignKind([c.productType, c.productName])
```

**Change 2:** Remove the direct printingMethod match block (lines 90–93). Delete these lines entirely:
```typescript
    if (includesToken(lineText, c.printingMethod)) {
      score += 30
      reasons.push('printingMethod')
    }
```

**Change 3:** Replace sizeLabel match (lines 98–101) with variant1Value OR variant2Value:
```typescript
// OLD:
    if (includesToken(lineText, c.sizeLabel)) {
      score += 10
      reasons.push('size')
    }
// NEW:
    if (includesToken(lineText, c.variant1Value) || includesToken(lineText, c.variant2Value)) {
      score += 10
      reasons.push('variant')
    }
```

After these changes, the `resolveSupplierForOrderLine` function body should look like:

```typescript
export function resolveSupplierForOrderLine(
  line: OrderLineForMapping,
  candidates: SupplierProductCandidate[],
): MappingResult {
  const lineText = [
    line.title,
    line.variantTitle,
    line.productType,
    ...(line.productTags ?? []),
  ].map(norm).filter(Boolean).join(' ')
  const lineDesignKind = detectDesignKind([line.productType, line.variantTitle, line.title, ...(line.productTags ?? [])])

  let best: MappingResult = { supplier: null, score: 0, reasons: [] }

  for (const c of candidates) {
    let score = 0
    const reasons: string[] = []

    const candidateDesignKind = detectDesignKind([c.productType, c.productName])
    if (lineDesignKind && candidateDesignKind) {
      if (lineDesignKind === candidateDesignKind) {
        score += 45
        reasons.push(`design:${lineDesignKind}`)
      } else {
        score -= 80
        reasons.push(`design-mismatch:${candidateDesignKind}`)
      }
    }

    if (includesToken(lineText, c.productType)) {
      score += 25
      reasons.push('productType')
    }
    if (includesToken(lineText, c.variant1Value) || includesToken(lineText, c.variant2Value)) {
      score += 10
      reasons.push('variant')
    }

    const nameOverlap = overlapScore(line.title, c.productName)
    if (nameOverlap > 0) {
      score += Math.min(20, nameOverlap * 5)
      reasons.push('productName')
    }

    score += Math.min(10, c.supplierPreferenceRank)

    if (
      !best.supplier ||
      score > best.score ||
      (score === best.score && c.supplierPreferenceRank > best.supplier.supplierPreferenceRank)
    ) {
      best = { supplier: score > 0 ? c : null, score, reasons }
    }
  }

  return best
}
```

- [ ] **Step 2.5: Update repos/suppliers.ts — ProductUpsertInput type**

In `src/lib/repos/suppliers.ts`, replace `ProductUpsertInput` (lines 166–181):

```typescript
export type ProductUpsertInput = {
  supplierId: string
  sku: string
  baseCost: number
  productName?: string | null
  currency?: string
  requiresDesign?: boolean
  baseSku?: string | null
  productType?: string | null
  variant1Name?: string | null
  variant1Value?: string | null
  variant2Name?: string | null
  variant2Value?: string | null
  designTemplateUrl?: string | null
  minProductionDays?: number | null
  maxProductionDays?: number | null
  shippingByRegion?: string | null
}
```

- [ ] **Step 2.6: Update repos/suppliers.ts — ProductBulkRow type**

In `src/lib/repos/suppliers.ts`, replace `ProductBulkRow` (lines 241–257):

```typescript
export type ProductBulkRow = {
  supplierName?: string | null
  supplierCode?: string | null
  sku: string
  baseCost: number
  productName?: string | null
  currency?: string
  requiresDesign?: boolean
  baseSku?: string | null
  productType?: string | null
  variant1Name?: string | null
  variant1Value?: string | null
  variant2Name?: string | null
  variant2Value?: string | null
  designTemplateUrl?: string | null
  minProductionDays?: number | null
  maxProductionDays?: number | null
  shippingByRegion?: string | null
}
```

- [ ] **Step 2.7: Update repos/suppliers.ts — buildSupplierProductCandidates**

In `buildSupplierProductCandidates` (around lines 58–74), replace the push block. Change:

```typescript
      productName: p.productName,
      productType: p.productType,
      printingMethod: p.printingMethod,
      sizeLabel: p.sizeLabel,
```

to:

```typescript
      productName: p.productName,
      productType: p.productType,
      variant1Name: p.variant1Name,
      variant1Value: p.variant1Value,
      variant2Name: p.variant2Name,
      variant2Value: p.variant2Value,
```

- [ ] **Step 2.8: Update repos/suppliers.ts — upsertProductMapping create block**

In `upsertProductMapping`, in the `create:` block (around lines 190–204), replace:

```typescript
        printingMethod: input.printingMethod ?? null,
        sizeLabel: input.sizeLabel ?? null,
```

with:

```typescript
        variant1Name: input.variant1Name ?? null,
        variant1Value: input.variant1Value ?? null,
        variant2Name: input.variant2Name ?? null,
        variant2Value: input.variant2Value ?? null,
```

- [ ] **Step 2.9: Update repos/suppliers.ts — upsertProductMapping update block**

In `upsertProductMapping`, in the `update:` block (around lines 206–218), replace:

```typescript
        ...(input.printingMethod !== undefined ? { printingMethod: input.printingMethod } : {}),
        ...(input.sizeLabel !== undefined ? { sizeLabel: input.sizeLabel } : {}),
```

with:

```typescript
        ...(input.variant1Name !== undefined ? { variant1Name: input.variant1Name } : {}),
        ...(input.variant1Value !== undefined ? { variant1Value: input.variant1Value } : {}),
        ...(input.variant2Name !== undefined ? { variant2Name: input.variant2Name } : {}),
        ...(input.variant2Value !== undefined ? { variant2Value: input.variant2Value } : {}),
```

- [ ] **Step 2.10: Run the new variant scoring test to verify it passes**

```powershell
npx vitest run tests/auto-mapping.test.ts --reporter=verbose
```

Expected: `scores variant1Value and variant2Value match` → PASS. The existing two tests will FAIL (printingMethod still in mock data causing type error) — that's OK, they'll be fixed in Task 3.

- [ ] **Step 2.11: Commit**

```powershell
git add src/lib/auto-mapping.ts src/lib/repos/suppliers.ts
git commit -m "feat: update auto-mapping and repo types for variant1/2 fields"
```

---

## Task 3: Update Tests

**Files:**
- Modify: `tests/auto-mapping.test.ts`

- [ ] **Step 3.1: Update first test — "uses product tags to distinguish 2D and 3D suppliers"**

The 3D candidate needs `productType: '3D Clothing'` (instead of `'Tshirt'`) so `detectDesignKind` can identify it from productType rather than the now-removed `printingMethod`. The 2D candidate needs `productType: 'DTG Tshirt'` for the same reason.

Replace the entire first test `it('uses product tags...')`:

```typescript
it('uses product tags to distinguish same visible variant between 2D and 3D suppliers without relying on design SKU', () => {
  const candidates: SupplierProductCandidate[] = [
    {
      ...base,
      sku: 'POMO-GIFT-TEE',
      supplierId: 'sup_2d',
      supplierName: '2D Supplier',
      supplierCode: '2d',
      baseCost: 8,
      productName: 'POMo Gift Shirt',
      productType: 'DTG Tshirt',
      variant1Name: 'Size',
      variant1Value: 'XL',
      variant2Name: null,
      variant2Value: null,
    },
    {
      ...base,
      sku: 'POMO-GIFT-TEE',
      supplierId: 'sup_3d',
      supplierName: '3D Supplier',
      supplierCode: '3d',
      baseCost: 14,
      productName: 'POMo Gift Shirt',
      productType: '3D Clothing',
      variant1Name: 'Size',
      variant1Value: 'XL',
      variant2Name: null,
      variant2Value: null,
    },
  ]

  const result = resolveSupplierForOrderLine({
    sku: 'DESIGN-POMO-001',
    title: 'POMo Gift Shirt',
    variantTitle: 'Tshirt / XL',
    productType: 'Tshirt',
    productTags: ['3D', 'gift'],
  }, candidates)

  expect(result.supplier?.supplierId).toBe('sup_3d')
  expect(result.supplier?.baseCost).toBe(14)
  expect(result.reasons).toContain('design:3D')
})
```

- [ ] **Step 3.2: Update second test — "falls back to preference rank"**

Add `variant1Name: null, variant1Value: null, variant2Name: null, variant2Value: null` to both candidates:

```typescript
it('falls back to preference rank when metadata cannot separate candidates', () => {
  const candidates: SupplierProductCandidate[] = [
    { ...base, sku: 'SUP-A', supplierId: 'low', baseCost: 10, supplierPreferenceRank: 1, variant1Name: null, variant1Value: null, variant2Name: null, variant2Value: null },
    { ...base, sku: 'SUP-B', supplierId: 'high', baseCost: 12, supplierPreferenceRank: 5, variant1Name: null, variant1Value: null, variant2Name: null, variant2Value: null },
  ]

  const result = resolveSupplierForOrderLine({
    sku: 'DESIGN-A',
    title: 'Plain Shirt',
    variantTitle: 'Tshirt',
    productTags: [],
  }, candidates)

  expect(result.supplier?.supplierId).toBe('high')
})
```

- [ ] **Step 3.3: Run all tests — verify all pass**

```powershell
npx vitest run tests/auto-mapping.test.ts --reporter=verbose
```

Expected:
```
✓ uses product tags to distinguish same visible variant between 2D and 3D suppliers
✓ falls back to preference rank when metadata cannot separate candidates
✓ scores variant1Value and variant2Value match against order line
```

All 3 pass.

- [ ] **Step 3.4: Commit**

```powershell
git add tests/auto-mapping.test.ts
git commit -m "test: update auto-mapping tests for variant fields"
```

---

## Task 4: Update API Route

**Files:**
- Modify: `src/app/api/suppliers/products/[id]/route.ts`

- [ ] **Step 4.1: Update PATCH handler — swap out printingMethod/sizeLabel for variant fields**

Replace the current PATCH handler body. The full new file is:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { deleteProductMapping, upsertProductMapping } from '@/lib/repos/suppliers'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const existing = await prisma.supplierProduct.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: 'At least one field required' }, { status: 400 })
  }
  const updated = await upsertProductMapping({
    supplierId: existing.supplierId,
    sku: existing.sku,
    baseCost: body.baseCost != null ? Number(body.baseCost) : existing.baseCost,
    productName: body.productName !== undefined ? body.productName : existing.productName,
    currency: body.currency ?? existing.currency,
    requiresDesign: body.requiresDesign !== undefined ? Boolean(body.requiresDesign) : existing.requiresDesign,
    baseSku: body.baseSku !== undefined ? body.baseSku : existing.baseSku,
    productType: body.productType !== undefined ? body.productType : existing.productType,
    variant1Name: body.variant1Name !== undefined ? body.variant1Name : existing.variant1Name,
    variant1Value: body.variant1Value !== undefined ? body.variant1Value : existing.variant1Value,
    variant2Name: body.variant2Name !== undefined ? body.variant2Name : existing.variant2Name,
    variant2Value: body.variant2Value !== undefined ? body.variant2Value : existing.variant2Value,
    designTemplateUrl: body.designTemplateUrl !== undefined ? body.designTemplateUrl : existing.designTemplateUrl,
    minProductionDays: body.minProductionDays !== undefined ? body.minProductionDays : existing.minProductionDays,
    maxProductionDays: body.maxProductionDays !== undefined ? body.maxProductionDays : existing.maxProductionDays,
    shippingByRegion: body.shippingByRegion !== undefined ? body.shippingByRegion : existing.shippingByRegion,
  })
  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteProductMapping(params.id)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4.2: TypeScript check**

```powershell
npx tsc --noEmit 2>&1 | Select-String "suppliers/products"
```

Expected: no errors for this file.

- [ ] **Step 4.3: Commit**

```powershell
git add src/app/api/suppliers/products/
git commit -m "feat: update PATCH handler for variant1/2 fields"
```

---

## Task 5: Redesign Supplier Detail Page

**Files:**
- Modify: `src/app/setup/suppliers/[id]/page.tsx`

This is a complete replacement of the component. The new design has:
- Import bar at top (compact, full-width)
- Single product setup table (full-width) with:
  - Inline add row (persistent at top of tbody)
  - Existing rows with ▸ expand toggle → expandable edit section
- No "Printing method" column
- Variant 1 Name/Value + Variant 2 Name/Value columns

- [ ] **Step 5.1: Write the new page component**

Replace the entire contents of `src/app/setup/suppliers/[id]/page.tsx` with:

```typescript
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, usePathname } from 'next/navigation'
import * as XLSX from 'xlsx'
import Sidebar from '@/components/Sidebar'
import { parseCsv } from '@/lib/csv-parser'

type Supplier = {
  id: string
  name: string
  code: string
  apiType: string | null
  firstItemShipFee: number
  additionalItemShipFee: number
  currency: string
  preferenceRank: number
  note: string | null
  isActive: boolean
}

type Product = {
  id: string
  sku: string
  productName: string | null
  baseCost: number
  currency: string
  requiresDesign: boolean
  updatedAt: string
  baseSku: string | null
  productType: string | null
  variant1Name: string | null
  variant1Value: string | null
  variant2Name: string | null
  variant2Value: string | null
  designTemplateUrl: string | null
  minProductionDays: number | null
  maxProductionDays: number | null
  shippingByRegion: string | null
}

type ImportRow = {
  sku: string
  baseCost: number
  productName?: string
  requiresDesign?: boolean
  baseSku?: string | null
  productType?: string | null
  variant1Name?: string | null
  variant1Value?: string | null
  variant2Name?: string | null
  variant2Value?: string | null
  designTemplateUrl?: string | null
  minProductionDays?: number | null
  maxProductionDays?: number | null
  shippingByRegion?: string | null
}

type AddRow = {
  productType: string
  baseSku: string
  variant1Name: string
  variant1Value: string
  variant2Name: string
  variant2Value: string
  sku: string
  baseCost: string
  usShipFirst: string
  usShipAdditional: string
}

type ExpandState = {
  designTemplateUrl: string
  minProductionDays: string
  maxProductionDays: string
  usShipFirst: string
  usShipAdditional: string
  euShipFirst: string
  euShipAdditional: string
  rowShipFirst: string
  rowShipAdditional: string
}

const emptyAddRow: AddRow = {
  productType: '',
  baseSku: '',
  variant1Name: '',
  variant1Value: '',
  variant2Name: '',
  variant2Value: '',
  sku: '',
  baseCost: '',
  usShipFirst: '',
  usShipAdditional: '',
}

function num(v: unknown): number {
  if (!v) return 0
  const n = parseFloat(v.toString().replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function buildShippingByRegion(usFirst: string, usAdditional: string): string | null {
  if (!usFirst && !usAdditional) return null
  return JSON.stringify({ US: { first: num(usFirst), additional: num(usAdditional) } })
}

function parseExcelRows(fileBuffer: ArrayBuffer): Record<string, string>[] {
  const workbook = XLSX.read(fileBuffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  const headerIndex = matrix.findIndex(row => row.map(String).some(cell => cell.trim() === 'SKU variant'))
  if (headerIndex < 0) return []
  const headers = matrix[headerIndex].map(cell => String(cell).trim())
  return matrix.slice(headerIndex + 1).map(row => {
    const obj: Record<string, string> = {}
    headers.forEach((header, index) => {
      if (header) obj[header] = String(row[index] ?? '').trim()
    })
    return obj
  })
}

function rowsToImportRows(rows: Record<string, unknown>[]): ImportRow[] {
  return rows.map(r => {
    const sku = String(r['SKU variant'] ?? r.sku ?? '').trim()
    const baseCost = num(r['Base cost ($)'] ?? r['Tier 1 (0 - 999)'] ?? r.baseCost ?? r.basecost ?? '0')
    const minProd = r['Min production time']
    const maxProd = r['Max production time']
    // Support both new column names and old 'SIZES' for backward compat
    const v1Value = String(r['Variant 1 Value'] ?? r['SIZES'] ?? '').trim() || null
    const v1Name = String(r['Variant 1 Name'] ?? '').trim() || (v1Value ? 'Size' : null)
    const shipping: Record<string, { first: number; additional: number; importTax?: number }> = {}
    const usFirst = r['US shipping fee (1st item)']
    const usAdditional = r['US additional shipping fee']
    const usTax = r['US import Tax/item']
    if (usFirst !== undefined || usAdditional !== undefined || usTax !== undefined) {
      shipping.US = { first: num(usFirst), additional: num(usAdditional) }
      if (num(usTax) > 0) shipping.US.importTax = num(usTax)
    }
    for (const zone of ['EU', 'GB', 'CA', 'ROW']) {
      const f = r[`${zone} shipping fee (1st item)`]
      const a = r[`${zone} additional shipping fee`]
      if (f !== undefined || a !== undefined) shipping[zone] = { first: num(f), additional: num(a) }
    }
    return {
      sku,
      baseCost,
      productName: String(r.productName ?? r['Product type'] ?? r['Product Title'] ?? '').trim() || undefined,
      requiresDesign: ['1', 'true', 'TRUE', 'yes', 'YES'].includes(String(r.requiresDesign ?? r.requiresdesign ?? '').trim()),
      baseSku: String(r['SKU product'] ?? '').trim() || null,
      productType: String(r['Product type'] ?? r['Product Title'] ?? '').trim() || null,
      variant1Name: v1Name,
      variant1Value: v1Value,
      variant2Name: String(r['Variant 2 Name'] ?? '').trim() || null,
      variant2Value: String(r['Variant 2 Value'] ?? '').trim() || null,
      designTemplateUrl: String(r['Design Template'] ?? '').trim() || null,
      minProductionDays: minProd ? parseInt(String(minProd), 10) : null,
      maxProductionDays: maxProd ? parseInt(String(maxProd), 10) : null,
      shippingByRegion: Object.keys(shipping).length > 0 ? JSON.stringify(shipping) : null,
    }
  }).filter(r => r.sku)
}

function initExpandState(p: Product): ExpandState {
  let s: Record<string, { first?: number; additional?: number }> = {}
  try { if (p.shippingByRegion) s = JSON.parse(p.shippingByRegion) } catch {}
  return {
    designTemplateUrl: p.designTemplateUrl ?? '',
    minProductionDays: p.minProductionDays?.toString() ?? '',
    maxProductionDays: p.maxProductionDays?.toString() ?? '',
    usShipFirst: (s.US?.first ?? '').toString(),
    usShipAdditional: (s.US?.additional ?? '').toString(),
    euShipFirst: (s.EU?.first ?? '').toString(),
    euShipAdditional: (s.EU?.additional ?? '').toString(),
    rowShipFirst: (s.ROW?.first ?? '').toString(),
    rowShipAdditional: (s.ROW?.additional ?? '').toString(),
  }
}

export default function SupplierSetupPage() {
  const params = useParams<{ id: string }>()
  const pathname = usePathname()
  const supplierId = params.id
  const suppliersPath = pathname.startsWith('/fulfillment') ? '/fulfillment/suppliers' : '/setup/suppliers'
  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [total, setTotal] = useState(0)
  const [addRow, setAddRow] = useState<AddRow>({ ...emptyAddRow })
  const [addBusy, setAddBusy] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportRow[] | null>(null)
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: any[] } | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [expandForms, setExpandForms] = useState<Record<string, ExpandState>>({})
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)

  const loadSupplier = useCallback(async () => {
    const r = await fetch(`/api/suppliers/${supplierId}`)
    if (r.ok) setSupplier(await r.json())
  }, [supplierId])

  const loadProducts = useCallback(async () => {
    const q = new URLSearchParams({ supplierId })
    if (search) q.set('search', search)
    const r = await fetch('/api/suppliers/products?' + q.toString())
    const d = await r.json()
    setProducts(d.products ?? [])
    setTotal(d.total ?? 0)
  }, [supplierId, search])

  useEffect(() => { loadSupplier() }, [loadSupplier])
  useEffect(() => { loadProducts() }, [loadProducts])

  const updateAddRow = (patch: Partial<AddRow>) => setAddRow(r => ({ ...r, ...patch }))

  const commitAddRow = async () => {
    if (!addRow.sku.trim()) { alert('SKU variant required'); return }
    if (!addRow.baseCost) { alert('Base cost required'); return }
    setAddBusy(true)
    const row: ImportRow = {
      sku: addRow.sku.trim(),
      baseCost: num(addRow.baseCost),
      productType: addRow.productType || null,
      productName: addRow.productType || undefined,
      baseSku: addRow.baseSku || null,
      variant1Name: addRow.variant1Name || null,
      variant1Value: addRow.variant1Value || null,
      variant2Name: addRow.variant2Name || null,
      variant2Value: addRow.variant2Value || null,
      shippingByRegion: buildShippingByRegion(addRow.usShipFirst, addRow.usShipAdditional),
    }
    const r = await fetch('/api/suppliers/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId, rows: [row] }),
    })
    if (r.ok) {
      setAddRow({ ...emptyAddRow })
      await loadProducts()
    }
    setAddBusy(false)
  }

  const onFilePick = async (file: File) => {
    const rows = /\.(xlsx|xls)$/i.test(file.name)
      ? parseExcelRows(await file.arrayBuffer())
      : parseCsv(await file.text())
    setImportPreview(rowsToImportRows(rows))
    setImportResult(null)
  }

  const commitImport = async () => {
    if (!importPreview) return
    setImportBusy(true)
    const r = await fetch('/api/suppliers/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId, rows: importPreview }),
    })
    const result = await r.json()
    setImportResult(result)
    setImportPreview(null)
    setImportBusy(false)
    if (fileRef.current) fileRef.current.value = ''
    await loadProducts()
  }

  const toggleExpand = (p: Product) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(p.id)) {
        next.delete(p.id)
        setExpandForms(f => { const n = { ...f }; delete n[p.id]; return n })
      } else {
        next.add(p.id)
        setExpandForms(f => ({ ...f, [p.id]: initExpandState(p) }))
      }
      return next
    })
  }

  const updateExpandForm = (id: string, patch: Partial<ExpandState>) => {
    setExpandForms(f => ({ ...f, [id]: { ...f[id], ...patch } }))
  }

  const cancelExpand = (id: string) => {
    setExpandedIds(prev => { const n = new Set(prev); n.delete(id); return n })
    setExpandForms(f => { const n = { ...f }; delete n[id]; return n })
  }

  const saveExpanded = async (p: Product) => {
    const es = expandForms[p.id]
    if (!es) return
    setSavingIds(prev => new Set(prev).add(p.id))
    const shipping: Record<string, { first: number; additional: number }> = {}
    if (es.usShipFirst || es.usShipAdditional) shipping.US = { first: num(es.usShipFirst), additional: num(es.usShipAdditional) }
    if (es.euShipFirst || es.euShipAdditional) shipping.EU = { first: num(es.euShipFirst), additional: num(es.euShipAdditional) }
    if (es.rowShipFirst || es.rowShipAdditional) shipping.ROW = { first: num(es.rowShipFirst), additional: num(es.rowShipAdditional) }
    const body = {
      designTemplateUrl: es.designTemplateUrl || null,
      minProductionDays: es.minProductionDays ? parseInt(es.minProductionDays, 10) : null,
      maxProductionDays: es.maxProductionDays ? parseInt(es.maxProductionDays, 10) : null,
      shippingByRegion: Object.keys(shipping).length > 0 ? JSON.stringify(shipping) : null,
    }
    const r = await fetch(`/api/suppliers/products/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.ok) {
      cancelExpand(p.id)
      await loadProducts()
    }
    setSavingIds(prev => { const n = new Set(prev); n.delete(p.id); return n })
  }

  const deleteOne = async (p: Product) => {
    if (!confirm(`Delete ${p.sku}?`)) return
    await fetch(`/api/suppliers/products/${p.id}`, { method: 'DELETE' })
    await loadProducts()
  }

  const usShipping = (p: Product) => {
    try {
      const s = p.shippingByRegion ? JSON.parse(p.shippingByRegion) : {}
      const us = s.US
      if (!us) return '—'
      return `$${(us.first ?? 0).toFixed(2)} / $${(us.additional ?? 0).toFixed(2)}`
    } catch { return '—' }
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="mb-lg">
          <a href={suppliersPath} className="text-secondary text-label-md">Back to fulfillments</a>
          <div className="flex items-start justify-between mt-sm gap-lg">
            <div>
              <h1 className="text-display-md">{supplier?.name ?? 'Supplier setup'}</h1>
              <p className="text-body-sm text-on-surface-variant mt-xs">
                Product catalog, SKU, cost, shipping và fulfillment export.
              </p>
            </div>
            <a href={`${suppliersPath}/${supplierId}/templates`} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
              Export templates
            </a>
          </div>
        </div>

        {supplier && (
          <div className="grid grid-cols-4 gap-md mb-lg">
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md">
              <div className="text-label-sm text-on-surface-variant">Code</div>
              <div className="font-mono text-body-md mt-xs">{supplier.code}</div>
            </div>
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md">
              <div className="text-label-sm text-on-surface-variant">Products</div>
              <div className="text-body-md mt-xs">{total}</div>
            </div>
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md">
              <div className="text-label-sm text-on-surface-variant">Default shipping</div>
              <div className="text-body-md mt-xs">${supplier.firstItemShipFee.toFixed(2)} / ${supplier.additionalItemShipFee.toFixed(2)}</div>
            </div>
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md">
              <div className="text-label-sm text-on-surface-variant">Auto mapping rank</div>
              <div className="text-body-md mt-xs">{supplier.preferenceRank}</div>
            </div>
          </div>
        )}

        {/* Import bar — compact, full width */}
        <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md mb-md flex items-center gap-lg flex-wrap">
          <div className="text-label-md font-semibold text-secondary whitespace-nowrap">📥 Import từ file</div>
          <div className="text-label-sm text-on-surface-variant flex-1 min-w-[200px]">
            Sheet cần có: Product type, SKU product, Variant 1 Name/Value, Variant 2 Name/Value, SKU variant, Base cost, shipping fee, production time
          </div>
          <label className="bg-secondary text-on-secondary px-md py-sm rounded-lg text-label-sm font-semibold cursor-pointer whitespace-nowrap">
            Choose File
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,text/csv"
              className="hidden"
              onChange={e => e.target.files?.[0] && onFilePick(e.target.files[0])}
            />
          </label>
        </div>

        {/* Import preview / result */}
        {importPreview && (
          <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md mb-md flex items-center gap-md">
            <span className="text-body-sm">Preview: {importPreview.length} row(s)</span>
            <button onClick={commitImport} disabled={importBusy} className="bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm disabled:opacity-50">
              {importBusy ? 'Saving...' : 'Save to this supplier'}
            </button>
            <button onClick={() => setImportPreview(null)} className="text-label-sm text-on-surface-variant">Cancel</button>
          </div>
        )}
        {importResult && (
          <div className="text-body-sm mb-md">
            Created: {importResult.created}, Updated: {importResult.updated}
            {importResult.errors?.length > 0 && <span className="text-error ml-md">{importResult.errors.length} error(s)</span>}
          </div>
        )}

        {/* Product setup table */}
        <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant/20 flex items-center justify-between">
            <div>
              <div className="text-title-md font-semibold">Product setup</div>
              <div className="text-label-sm text-on-surface-variant mt-xs">Mỗi dòng là một supplier SKU variant</div>
            </div>
            <input
              placeholder="Search SKU or product"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border rounded-lg px-md py-sm text-body-sm w-[260px]"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-label-sm border-collapse">
              <thead className="bg-surface-container text-left">
                <tr>
                  <th className="w-8 px-sm py-xs"></th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">Product type</th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">SKU product</th>
                  <th className="px-sm py-xs text-secondary font-semibold bg-secondary/5">
                    <div>Variant 1</div>
                    <div className="flex gap-xs mt-[2px]">
                      <span className="bg-secondary/10 text-secondary px-xs rounded text-[10px]">Name</span>
                      <span className="bg-secondary/10 text-secondary px-xs rounded text-[10px]">Value</span>
                    </div>
                  </th>
                  <th className="px-sm py-xs text-secondary font-semibold bg-secondary/5">
                    <div>Variant 2 <span className="text-[10px] text-on-surface-variant font-normal">(opt)</span></div>
                    <div className="flex gap-xs mt-[2px]">
                      <span className="bg-secondary/10 text-secondary px-xs rounded text-[10px]">Name</span>
                      <span className="bg-secondary/10 text-secondary px-xs rounded text-[10px]">Value</span>
                    </div>
                  </th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">SKU variant</th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">Base cost</th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold text-center">
                    <div>US Shipping</div>
                    <div className="text-[10px] font-normal text-on-surface-variant">1st / add.</div>
                  </th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {/* Add row */}
                <tr className="bg-surface border-b border-outline-variant/20">
                  <td className="px-sm py-xs text-on-surface-variant text-center">+</td>
                  <td className="px-xs py-xs"><input className="w-36 border rounded px-xs py-[3px]" placeholder="3D Clothing" value={addRow.productType} onChange={e => updateAddRow({ productType: e.target.value })} /></td>
                  <td className="px-xs py-xs"><input className="w-24 border rounded px-xs py-[3px] font-mono" placeholder="TX" value={addRow.baseSku} onChange={e => updateAddRow({ baseSku: e.target.value })} /></td>
                  <td className="px-xs py-xs bg-secondary/5">
                    <div className="flex gap-xs">
                      <input className="w-16 border rounded px-xs py-[3px]" placeholder="Size" value={addRow.variant1Name} onChange={e => updateAddRow({ variant1Name: e.target.value })} />
                      <input className="w-14 border rounded px-xs py-[3px]" placeholder="XL" value={addRow.variant1Value} onChange={e => updateAddRow({ variant1Value: e.target.value })} />
                    </div>
                  </td>
                  <td className="px-xs py-xs bg-secondary/5">
                    <div className="flex gap-xs">
                      <input className="w-16 border rounded px-xs py-[3px]" placeholder="Color" value={addRow.variant2Name} onChange={e => updateAddRow({ variant2Name: e.target.value })} />
                      <input className="w-14 border rounded px-xs py-[3px]" placeholder="Black" value={addRow.variant2Value} onChange={e => updateAddRow({ variant2Value: e.target.value })} />
                    </div>
                  </td>
                  <td className="px-xs py-xs"><input className="w-32 border rounded px-xs py-[3px] font-mono" placeholder="TX-XL-BLK" value={addRow.sku} onChange={e => updateAddRow({ sku: e.target.value })} /></td>
                  <td className="px-xs py-xs"><input className="w-20 border rounded px-xs py-[3px]" type="number" step="0.01" placeholder="10.00" value={addRow.baseCost} onChange={e => updateAddRow({ baseCost: e.target.value })} /></td>
                  <td className="px-xs py-xs">
                    <div className="flex gap-xs items-center">
                      <input className="w-14 border rounded px-xs py-[3px] text-center" type="number" step="0.01" placeholder="4.00" value={addRow.usShipFirst} onChange={e => updateAddRow({ usShipFirst: e.target.value })} />
                      <span className="text-on-surface-variant">/</span>
                      <input className="w-14 border rounded px-xs py-[3px] text-center" type="number" step="0.01" placeholder="1.50" value={addRow.usShipAdditional} onChange={e => updateAddRow({ usShipAdditional: e.target.value })} />
                    </div>
                  </td>
                  <td className="px-xs py-xs">
                    <button onClick={commitAddRow} disabled={addBusy} className="bg-secondary text-on-secondary px-sm py-[3px] rounded text-[11px] font-semibold disabled:opacity-50">
                      {addBusy ? '...' : 'Add'}
                    </button>
                  </td>
                </tr>

                {/* Existing rows */}
                {products.map(p => (
                  <React.Fragment key={p.id}>
                    <tr className={`border-b border-outline-variant/10 ${expandedIds.has(p.id) ? 'bg-secondary/5' : 'hover:bg-surface-container/30'}`}>
                      <td className="px-sm py-sm text-center">
                        <button onClick={() => toggleExpand(p)} className="text-secondary transition-transform duration-150" style={{ display: 'inline-block', transform: expandedIds.has(p.id) ? 'rotate(90deg)' : 'none' }}>
                          <span className="material-icons text-[16px]">chevron_right</span>
                        </button>
                      </td>
                      <td className="px-sm py-sm text-body-sm">{p.productType || '—'}</td>
                      <td className="px-sm py-sm font-mono text-xs text-on-surface-variant">{p.baseSku || '—'}</td>
                      <td className="px-sm py-sm bg-secondary/5">
                        {p.variant1Value ? (
                          <>
                            <div className="text-[10px] text-on-surface-variant">{p.variant1Name}</div>
                            <div className="text-label-sm font-semibold text-secondary">{p.variant1Value}</div>
                          </>
                        ) : <span className="text-on-surface-variant">—</span>}
                      </td>
                      <td className="px-sm py-sm bg-secondary/5">
                        {p.variant2Value ? (
                          <>
                            <div className="text-[10px] text-on-surface-variant">{p.variant2Name}</div>
                            <div className="text-label-sm font-semibold text-secondary">{p.variant2Value}</div>
                          </>
                        ) : <span className="text-on-surface-variant">—</span>}
                      </td>
                      <td className="px-sm py-sm font-mono text-xs">{p.sku}</td>
                      <td className="px-sm py-sm text-green-700 font-semibold text-body-sm">{p.currency} {p.baseCost.toFixed(2)}</td>
                      <td className="px-sm py-sm text-body-sm text-center">{usShipping(p)}</td>
                      <td className="px-sm py-sm text-center">
                        <button onClick={() => deleteOne(p)} className="text-error text-label-sm hover:opacity-70">✕</button>
                      </td>
                    </tr>
                    {expandedIds.has(p.id) && expandForms[p.id] && (
                      <tr key={`${p.id}-expand`}>
                        <td colSpan={9} className="px-lg py-md bg-secondary/5 border-b border-secondary/20">
                          <div className="grid grid-cols-4 gap-md mb-sm">
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">Design Template URL</label>
                              <input
                                className="w-full border rounded-lg px-sm py-xs text-body-sm"
                                placeholder="https://drive.google.com/..."
                                value={expandForms[p.id].designTemplateUrl}
                                onChange={e => updateExpandForm(p.id, { designTemplateUrl: e.target.value })}
                              />
                            </div>
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">Production days (min – max)</label>
                              <div className="flex items-center gap-xs">
                                <input
                                  className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center"
                                  type="number"
                                  placeholder="3"
                                  value={expandForms[p.id].minProductionDays}
                                  onChange={e => updateExpandForm(p.id, { minProductionDays: e.target.value })}
                                />
                                <span className="text-on-surface-variant">–</span>
                                <input
                                  className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center"
                                  type="number"
                                  placeholder="7"
                                  value={expandForms[p.id].maxProductionDays}
                                  onChange={e => updateExpandForm(p.id, { maxProductionDays: e.target.value })}
                                />
                              </div>
                            </div>
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">US Shipping (1st / add.)</label>
                              <div className="flex items-center gap-xs">
                                <input
                                  className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center"
                                  type="number" step="0.01" placeholder="4.50"
                                  value={expandForms[p.id].usShipFirst}
                                  onChange={e => updateExpandForm(p.id, { usShipFirst: e.target.value })}
                                />
                                <span className="text-on-surface-variant">/</span>
                                <input
                                  className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center"
                                  type="number" step="0.01" placeholder="1.50"
                                  value={expandForms[p.id].usShipAdditional}
                                  onChange={e => updateExpandForm(p.id, { usShipAdditional: e.target.value })}
                                />
                              </div>
                            </div>
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">EU Shipping (1st / add.)</label>
                              <div className="flex items-center gap-xs">
                                <input
                                  className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center"
                                  type="number" step="0.01" placeholder="6.00"
                                  value={expandForms[p.id].euShipFirst}
                                  onChange={e => updateExpandForm(p.id, { euShipFirst: e.target.value })}
                                />
                                <span className="text-on-surface-variant">/</span>
                                <input
                                  className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center"
                                  type="number" step="0.01" placeholder="2.00"
                                  value={expandForms[p.id].euShipAdditional}
                                  onChange={e => updateExpandForm(p.id, { euShipAdditional: e.target.value })}
                                />
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-4 gap-md">
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">Other regions (1st / add.)</label>
                              <div className="flex items-center gap-xs">
                                <input
                                  className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center"
                                  type="number" step="0.01" placeholder="7.00"
                                  value={expandForms[p.id].rowShipFirst}
                                  onChange={e => updateExpandForm(p.id, { rowShipFirst: e.target.value })}
                                />
                                <span className="text-on-surface-variant">/</span>
                                <input
                                  className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center"
                                  type="number" step="0.01" placeholder="2.50"
                                  value={expandForms[p.id].rowShipAdditional}
                                  onChange={e => updateExpandForm(p.id, { rowShipAdditional: e.target.value })}
                                />
                              </div>
                            </div>
                            <div />
                            <div />
                            <div className="flex items-end justify-end gap-sm">
                              <button onClick={() => cancelExpand(p.id)} className="px-md py-xs rounded-lg border text-label-sm">Cancel</button>
                              <button
                                onClick={() => saveExpanded(p)}
                                disabled={savingIds.has(p.id)}
                                className="bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm disabled:opacity-50"
                              >
                                {savingIds.has(p.id) ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}

                {products.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-lg py-xl text-center text-on-surface-variant">
                      No products yet. Import a sheet or fill in the row above and click Add.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  )
}
```

> **Note:** Add `import React from 'react'` at the top if `React.Fragment` is not auto-imported in this project. Check the existing imports in other pages — if they use `<>` shorthand without importing React, use `<>...</>` instead of `<React.Fragment>` and add a `key` via a wrapper `<tr>` approach (see Step 5.3).

- [ ] **Step 5.2: Fix React.Fragment key issue if needed**

If the project doesn't have `import React from 'react'`, the `<React.Fragment key={p.id}>` usage needs to be replaced. Change:

```tsx
{products.map(p => (
  <React.Fragment key={p.id}>
    <tr>...</tr>
    {expandedIds.has(p.id) && <tr key={`${p.id}-expand`}>...</tr>}
  </React.Fragment>
))}
```

The import line at the top should have React added:
```typescript
import React, { useCallback, useEffect, useRef, useState } from 'react'
```

- [ ] **Step 5.3: TypeScript check**

```powershell
npx tsc --noEmit 2>&1 | Select-String "suppliers/\[id\]"
```

Expected: no errors.

- [ ] **Step 5.4: Start dev server and verify supplier detail page**

```powershell
npm run dev
```

Navigate to `http://localhost:3000/setup/suppliers/<any-supplier-id>`.

Verify:
- Import bar shows at top (compact, full-width, "Choose File" button)
- Product setup table shows below (full width)
- Add row is at top of table with Variant 1/2 inputs
- Existing products show Variant 1/2 columns (no Print/Size columns)
- ▸ chevron expands a row showing Design URL, Prod days, US/EU/Other shipping inputs
- Save in expanded section calls API and closes the row
- ✕ deletes with confirmation

- [ ] **Step 5.5: Commit**

```powershell
git add src/app/setup/suppliers/
git commit -m "feat: redesign supplier detail page with stacked layout and expandable rows"
```

---

## Task 6: Update Products Page

**Files:**
- Modify: `src/app/setup/products/page.tsx`

Changes: remove `printingMethod`/`sizeLabel` from all types, add variant fields; update display table, manual entry table, and edit modal.

- [ ] **Step 6.1: Update Product type**

In `src/app/setup/products/page.tsx`, replace the `Product` type (lines 9–26):

```typescript
type Product = {
  id: string
  sku: string
  productName: string | null
  baseCost: number
  currency: string
  requiresDesign: boolean
  updatedAt: string
  baseSku: string | null
  productType: string | null
  variant1Name: string | null
  variant1Value: string | null
  variant2Name: string | null
  variant2Value: string | null
  designTemplateUrl: string | null
  minProductionDays: number | null
  maxProductionDays: number | null
  shippingByRegion: string | null
  supplier: { id: string; name: string; code: string; currency: string }
}
```

- [ ] **Step 6.2: Update ImportRow type**

Replace `ImportRow` (lines 28–42):

```typescript
type ImportRow = {
  supplierName?: string | null
  sku: string
  baseCost: number
  productName?: string
  requiresDesign?: boolean
  baseSku?: string | null
  productType?: string | null
  variant1Name?: string | null
  variant1Value?: string | null
  variant2Name?: string | null
  variant2Value?: string | null
  designTemplateUrl?: string | null
  minProductionDays?: number | null
  maxProductionDays?: number | null
  shippingByRegion?: string | null
}
```

- [ ] **Step 6.3: Update ManualRow type and emptyManualRow**

Replace `ManualRow` type (lines 44–58) and `emptyManualRow` (lines 60–74):

```typescript
type ManualRow = {
  supplierName: string
  productType: string
  baseSku: string
  variant1Name: string
  variant1Value: string
  variant2Name: string
  variant2Value: string
  sku: string
  baseCost: string
  usImportTax: string
  usShipFirst: string
  usShipAdditional: string
  designTemplateUrl: string
  minProductionDays: string
  maxProductionDays: string
}

const emptyManualRow: ManualRow = {
  supplierName: '',
  productType: '',
  baseSku: '',
  variant1Name: '',
  variant1Value: '',
  variant2Name: '',
  variant2Value: '',
  sku: '',
  baseCost: '',
  usImportTax: '',
  usShipFirst: '',
  usShipAdditional: '',
  designTemplateUrl: '',
  minProductionDays: '',
  maxProductionDays: '',
}
```

- [ ] **Step 6.4: Update rowsToImportRows function**

Replace `rowsToImportRows` (lines 117–139):

```typescript
function rowsToImportRows(rows: Record<string, unknown>[]): ImportRow[] {
  return rows.map(r => {
    const sku = String(r['SKU variant'] ?? r.sku ?? '').trim()
    const baseCost = num(r['Base cost ($)'] ?? r['Tier 1 (0 - 999)'] ?? r.baseCost ?? r.basecost ?? '0')
    const minProd = r['Min production time']
    const maxProd = r['Max production time']
    const v1Value = String(r['Variant 1 Value'] ?? r['SIZES'] ?? '').trim() || null
    const v1Name = String(r['Variant 1 Name'] ?? '').trim() || (v1Value ? 'Size' : null)
    const shipping: Record<string, { first: number; additional: number; importTax?: number }> = {}
    const usFirst = r['US shipping fee (1st item)']
    const usAdditional = r['US additional shipping fee']
    const usTax = r['US import Tax/item']
    if (usFirst !== undefined || usAdditional !== undefined || usTax !== undefined) {
      shipping.US = { first: num(usFirst), additional: num(usAdditional) }
      if (num(usTax) > 0) shipping.US.importTax = num(usTax)
    }
    for (const zone of ['EU', 'GB', 'CA', 'ROW']) {
      const f = r[`${zone} shipping fee (1st item)`]
      const a = r[`${zone} additional shipping fee`]
      if (f !== undefined || a !== undefined) shipping[zone] = { first: num(f), additional: num(a) }
    }
    return {
      supplierName: String(r['SUPPLIER NAME'] ?? r['Supplier Name'] ?? r.supplierName ?? r.supplier ?? '').trim() || null,
      sku,
      baseCost,
      productName: String(r.productName ?? r['Product type'] ?? r['Product Title'] ?? '').trim() || undefined,
      requiresDesign: ['1', 'true', 'TRUE', 'yes', 'YES'].includes(String(r.requiresDesign ?? r.requiresdesign ?? '').trim()),
      baseSku: String(r['SKU product'] ?? '').trim() || null,
      productType: String(r['Product type'] ?? r['Product Title'] ?? '').trim() || null,
      variant1Name: v1Name,
      variant1Value: v1Value,
      variant2Name: String(r['Variant 2 Name'] ?? '').trim() || null,
      variant2Value: String(r['Variant 2 Value'] ?? '').trim() || null,
      designTemplateUrl: String(r['Design Template'] ?? '').trim() || null,
      minProductionDays: minProd ? parseInt(String(minProd), 10) : null,
      maxProductionDays: maxProd ? parseInt(String(maxProd), 10) : null,
      shippingByRegion: Object.keys(shipping).length > 0 ? JSON.stringify(shipping) : null,
    }
  }).filter(r => r.sku)
}
```

- [ ] **Step 6.5: Update manualRowsToImport function**

In `manualRowsToImport` (lines 266–286), replace the return object to use variant fields:

```typescript
  const manualRowsToImport = (): ImportRow[] => {
    const fallbackSupplier = suppliers.find(s => s.id === supplierId)?.name ?? ''
    return manualRows.map(r => ({
      supplierName: r.supplierName || fallbackSupplier || null,
      sku: r.sku.trim(),
      baseCost: num(r.baseCost),
      productName: r.productType || undefined,
      baseSku: r.baseSku || null,
      productType: r.productType || null,
      variant1Name: r.variant1Name || null,
      variant1Value: r.variant1Value || null,
      variant2Name: r.variant2Name || null,
      variant2Value: r.variant2Value || null,
      designTemplateUrl: r.designTemplateUrl || null,
      minProductionDays: r.minProductionDays ? parseInt(r.minProductionDays, 10) : null,
      maxProductionDays: r.maxProductionDays ? parseInt(r.maxProductionDays, 10) : null,
      shippingByRegion: buildShippingByRegion({
        'US import Tax/item': r.usImportTax,
        'US shipping fee (1st item)': r.usShipFirst,
        'US additional shipping fee': r.usShipAdditional,
      }),
    })).filter(r => r.sku)
  }
```

- [ ] **Step 6.6: Update openEdit function**

In `openEdit` (lines 196–215), replace `printingMethod` and `sizeLabel` with variant fields:

```typescript
  const openEdit = (p: Product) => {
    let ship: any = {}
    try { if (p.shippingByRegion) ship = JSON.parse(p.shippingByRegion) } catch {}
    setEditingId(p.id)
    setEditForm({
      sku: p.sku,
      baseCost: p.baseCost,
      productName: p.productName ?? '',
      currency: p.currency,
      requiresDesign: p.requiresDesign,
      baseSku: p.baseSku ?? '',
      productType: p.productType ?? '',
      variant1Name: p.variant1Name ?? '',
      variant1Value: p.variant1Value ?? '',
      variant2Name: p.variant2Name ?? '',
      variant2Value: p.variant2Value ?? '',
      designTemplateUrl: p.designTemplateUrl ?? '',
      minProductionDays: p.minProductionDays ?? '',
      maxProductionDays: p.maxProductionDays ?? '',
      shipping: ship,
    })
  }
```

- [ ] **Step 6.7: Update saveEdit function**

In `saveEdit` (lines 217–239), replace `printingMethod` and `sizeLabel` in the body:

```typescript
  const saveEdit = async () => {
    if (!editingId || !editForm) return
    const shippingByRegion = Object.keys(editForm.shipping).length > 0 ? JSON.stringify(editForm.shipping) : null
    const body = {
      baseCost: Number(editForm.baseCost),
      productName: editForm.productName || null,
      currency: editForm.currency,
      requiresDesign: editForm.requiresDesign,
      baseSku: editForm.baseSku || null,
      productType: editForm.productType || null,
      variant1Name: editForm.variant1Name || null,
      variant1Value: editForm.variant1Value || null,
      variant2Name: editForm.variant2Name || null,
      variant2Value: editForm.variant2Value || null,
      designTemplateUrl: editForm.designTemplateUrl || null,
      minProductionDays: editForm.minProductionDays === '' ? null : Number(editForm.minProductionDays),
      maxProductionDays: editForm.maxProductionDays === '' ? null : Number(editForm.maxProductionDays),
      shippingByRegion,
    }
    await fetch(`/api/suppliers/products/${editingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setEditingId(null); setEditForm(null); await load()
  }
```

- [ ] **Step 6.8: Update manual entry table header and inputs**

In the manual entry table `<thead>` (around line 396), replace `'Printing method'` and `'SIZES'` columns with variant columns:

```tsx
{['SUPPLIER NAME', 'Product type', 'SKU product', 'Variant 1 Name', 'Variant 1 Value', 'Variant 2 Name', 'Variant 2 Value', 'SKU variant', 'Base cost ($)', 'US import Tax/item', 'US shipping fee (1st item)', 'US additional shipping fee', 'Design Template', 'Min production time', 'Max production time', ''].map(h => (
  <th key={h} className="px-sm py-xs">{h}</th>
))}
```

In the `<tbody>` manual row inputs, replace the `printingMethod` and `sizeLabel` `<td>` cells with four variant `<td>` cells:

```tsx
// REMOVE:
<td className="px-sm py-xs"><input className="w-36 border rounded px-xs py-[3px]" value={row.printingMethod} onChange={e => updateManualRow(index, { printingMethod: e.target.value })} /></td>
<td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" value={row.sizeLabel} onChange={e => updateManualRow(index, { sizeLabel: e.target.value })} /></td>

// ADD:
<td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" placeholder="Size" value={row.variant1Name} onChange={e => updateManualRow(index, { variant1Name: e.target.value })} /></td>
<td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" placeholder="XL" value={row.variant1Value} onChange={e => updateManualRow(index, { variant1Value: e.target.value })} /></td>
<td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" placeholder="Color" value={row.variant2Name} onChange={e => updateManualRow(index, { variant2Name: e.target.value })} /></td>
<td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" placeholder="Black" value={row.variant2Value} onChange={e => updateManualRow(index, { variant2Value: e.target.value })} /></td>
```

- [ ] **Step 6.9: Update products display table — replace Size column with Variant 1/2**

In the products display `<thead>` (around line 433), replace `<th>Size</th>` with two columns:

```tsx
// REMOVE:
<th className="px-md py-sm">Size</th>

// ADD:
<th className="px-md py-sm">Variant 1</th>
<th className="px-md py-sm">Variant 2</th>
```

In the products display `<tbody>`, replace the Size `<td>` (around line 461):

```tsx
// REMOVE:
<td className="px-md py-sm text-xs">{p.sizeLabel ?? '—'}</td>

// ADD:
<td className="px-md py-sm text-xs">
  {p.variant1Value ? (
    <span><span className="text-on-surface-variant">{p.variant1Name}: </span>{p.variant1Value}</span>
  ) : '—'}
</td>
<td className="px-md py-sm text-xs">
  {p.variant2Value ? (
    <span><span className="text-on-surface-variant">{p.variant2Name}: </span>{p.variant2Value}</span>
  ) : '—'}
</td>
```

Also in the Product/Type column (around line 453–456), remove `printingMethod` display:

```tsx
// REMOVE:
{p.printingMethod && <div className="text-xs text-on-surface-variant">{p.printingMethod}</div>}
```

Update `colSpan` on the empty-row td from 9 to 10 (two more columns now):
```tsx
<tr><td colSpan={10} className="px-md py-lg text-center text-on-surface-variant">No mappings. Add or import CSV.</td></tr>
```

- [ ] **Step 6.10: Update edit modal — remove printingMethod/sizeLabel, add variant fields**

In the edit modal `<div className="grid grid-cols-2 gap-sm">` (around line 504), replace:

```tsx
// REMOVE:
<div><label className="text-label-sm block mb-xs">Printing method</label><input className="w-full border rounded-lg px-sm py-xs" value={editForm.printingMethod} onChange={e => setEditForm({...editForm, printingMethod: e.target.value})} /></div>
<div><label className="text-label-sm block mb-xs">Size label</label><input className="w-full border rounded-lg px-sm py-xs" value={editForm.sizeLabel} onChange={e => setEditForm({...editForm, sizeLabel: e.target.value})} /></div>

// ADD:
<div><label className="text-label-sm block mb-xs">Variant 1 Name</label><input className="w-full border rounded-lg px-sm py-xs" placeholder="Size, Color, Capacity..." value={editForm.variant1Name} onChange={e => setEditForm({...editForm, variant1Name: e.target.value})} /></div>
<div><label className="text-label-sm block mb-xs">Variant 1 Value</label><input className="w-full border rounded-lg px-sm py-xs" placeholder="XL, Black, 10oz..." value={editForm.variant1Value} onChange={e => setEditForm({...editForm, variant1Value: e.target.value})} /></div>
<div><label className="text-label-sm block mb-xs">Variant 2 Name</label><input className="w-full border rounded-lg px-sm py-xs" placeholder="Color, Style..." value={editForm.variant2Name} onChange={e => setEditForm({...editForm, variant2Name: e.target.value})} /></div>
<div><label className="text-label-sm block mb-xs">Variant 2 Value</label><input className="w-full border rounded-lg px-sm py-xs" placeholder="White, Matte..." value={editForm.variant2Value} onChange={e => setEditForm({...editForm, variant2Value: e.target.value})} /></div>
```

- [ ] **Step 6.11: TypeScript check**

```powershell
npx tsc --noEmit 2>&1 | Select-String "setup/products"
```

Expected: no errors.

- [ ] **Step 6.12: Verify products page in browser**

Navigate to `http://localhost:3000/setup/products` (or `http://localhost:3000/fulfillment/products`).

Verify:
- No "Size" column — replaced by "Variant 1" and "Variant 2" columns
- No "Printing method" column or display
- Edit modal shows Variant 1 Name/Value + Variant 2 Name/Value instead of Printing method/Size label
- Manual entry table has Variant 1/2 name/value columns instead of Printing method/SIZES

- [ ] **Step 6.13: Commit**

```powershell
git add src/app/setup/products/page.tsx
git commit -m "feat: update products page — variant columns, updated edit modal and CSV parsing"
```

---

## Spec Coverage Self-Review

| Spec section | Covered by |
|---|---|
| 1. Schema: remove printingMethod, sizeLabel | Task 1 |
| 1. Schema: add variant1Name/Value, variant2Name/Value | Task 1 |
| 1. Migration: sizeLabel → variant1Value, variant1Name='Size' | Task 1, Step 1.3 |
| 1. SCHEMA_VERSION bump | Task 1, Step 1.6 |
| 2. auto-mapping: remove printingMethod from SupplierProductCandidate | Task 2, Step 2.3 |
| 2. auto-mapping: remove sizeLabel, add variant fields | Task 2, Step 2.3 |
| 2. auto-mapping: remove DESIGN_2D/DESIGN_3D/detectDesignKind | NOT removed — kept because lineDesignKind still needs them; only candidateDesignKind no longer includes printingMethod |
| 2. auto-mapping: sizeLabel matching → variant1Value OR variant2Value | Task 2, Step 2.4 |
| 2. Tests: update mock data | Task 3 |
| 3. Repo: ProductUpsertInput update | Task 2, Step 2.5 |
| 3. Repo: ProductBulkRow update | Task 2, Step 2.6 |
| 3. Repo: buildSupplierProductCandidates update | Task 2, Step 2.7 |
| 3. Repo: upsertProductMapping create/update | Task 2, Steps 2.8–2.9 |
| 4. API PATCH route update | Task 4 |
| 5. Supplier detail: import bar at top | Task 5 |
| 5. Supplier detail: full-width manual entry | Task 5 |
| 5. Supplier detail: Variant 1/2 columns | Task 5 |
| 5. Supplier detail: expandable rows | Task 5 |
| 5. Supplier detail: remove printingMethod column | Task 5 |
| 6. Products page: column changes | Task 6 |
| 6. Products page: edit modal | Task 6 |
| 7. CSV import column mapping | Task 5 Step 5.1 (rowsToImportRows), Task 6 Step 6.4 |

> **Note on DESIGN_2D/DESIGN_3D:** The spec says "remove design-type detection arrays that rely on printingMethod." These arrays don't themselves rely on printingMethod — they're used by `detectDesignKind` which is called both for `lineDesignKind` (order line detection — still needed) and `candidateDesignKind` (supplier side — updated to no longer pass `c.printingMethod`). Keeping the arrays and function is correct; removing them would break lineDesignKind detection.
