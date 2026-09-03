# Design SKU Reuse & Card Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make design files reliably reach export by treating every mapped product line as needing design, reusing completed designs per SKU from the library, and creating a Trello card the first time a SKU has no design.

**Architecture:** Rewire the existing `SkuSupplierDesign` (reuse library) + `SkuDesign` (master artwork) machinery. Drop the unreliable `requiresDesign` flag as the design trigger; a line needs design when it is a product line mapped to a supplier. NON_CUSTOM reuses the library by full SKU+supplier; CUSTOM never reuses and always gets a card. Library population is made multi-line-safe by matching each SKU to its own Drive file.

**Tech Stack:** Next.js 14 API routes, Prisma 7 + libSQL (SQLite), vitest, Trello REST.

**Spec:** `docs/superpowers/specs/2026-09-03-design-sku-reuse-design.md`

## Global Constraints

- No Prisma schema change; no migration. Reuse existing `SkuSupplierDesign` and `SkuDesign`.
- Import prisma via `import { prisma } from '@/lib/db'`. Never import from `@/generated/prisma` directly.
- Tests run with `npm test` (vitest). Test files live next to source as `*.test.ts`.
- Reuse key is the **full Shopify SKU** string + supplierId (verbatim, unmodified).
- A line "needs design" ⟺ `!isNonProductLine(line) && resolvedSupplierId != null`.
- Dev server port 3002. Production DB lives on the VPS at `/home/podmanager/dev.db`.

---

### Task 1: `resolveOrderDesign` — guard link + CUSTOM no-reuse

**Files:**
- Modify: `src/lib/design-library.ts:23-41`
- Test: `src/lib/design-library.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveOrderDesign(lines: DesignLineInput[], lookup: LibraryLookup, opts?: { allowReuse?: boolean }): DesignResolution`. `allowReuse` defaults to `true`. When `false`, the library `lookup` is not consulted (a line is satisfied only by its own `existingDesignLink`). A library entry counts as satisfying a line only when `entry.ready && entry.designLink` (a ready entry with a null link is treated as missing).

- [ ] **Step 1: Write failing tests**

Add to `src/lib/design-library.test.ts` inside the `describe('resolveOrderDesign', ...)` block:

```typescript
it('ready-but-null-link entry is treated as missing', () => {
  const r = resolveOrderDesign(
    [baseLine({ sku: 'SKU1', resolvedSupplierId: 'supA' })],
    lookupFrom({ [designKey('SKU1', 'supA')]: { ready: true, designLink: null } }),
  )
  expect(r.orderDesignReady).toBe(false)
  expect(r.missing).toEqual([{ index: 0, sku: 'SKU1', supplierId: 'supA' }])
})

it('allowReuse:false ignores the library (always missing without own link)', () => {
  const r = resolveOrderDesign(
    [baseLine({ sku: 'SKU1', resolvedSupplierId: 'supA' })],
    lookupFrom({ [designKey('SKU1', 'supA')]: { ready: true, designLink: 'http://d/1' } }),
    { allowReuse: false },
  )
  expect(r.orderDesignReady).toBe(false)
  expect(r.lineLinks).toEqual([])
  expect(r.missing).toEqual([{ index: 0, sku: 'SKU1', supplierId: 'supA' }])
})

it('allowReuse:false still honors own existing design link', () => {
  const r = resolveOrderDesign(
    [baseLine({ existingDesignLink: 'http://trello/link' })],
    lookupFrom({}),
    { allowReuse: false },
  )
  expect(r.orderDesignReady).toBe(true)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- design-library`
Expected: the two new reuse/guard tests FAIL (current code treats ready as satisfied and ignores `allowReuse`).

- [ ] **Step 3: Implement**

Replace the body of `resolveOrderDesign` in `src/lib/design-library.ts`:

```typescript
export function resolveOrderDesign(
  lines: DesignLineInput[],
  lookup: LibraryLookup,
  opts?: { allowReuse?: boolean },
): DesignResolution {
  const allowReuse = opts?.allowReuse !== false
  const designLines = lines.filter(l => !l.isNonProduct && l.requiresDesign)
  const lineLinks: DesignResolution['lineLinks'] = []
  const missing: DesignResolution['missing'] = []

  for (const line of designLines) {
    if (line.existingDesignLink) continue
    const entry = allowReuse && line.sku && line.resolvedSupplierId
      ? lookup(line.sku, line.resolvedSupplierId)
      : null
    if (entry && entry.ready && entry.designLink) {
      lineLinks.push({ index: line.index, designLink: entry.designLink })
      continue
    }
    missing.push({ index: line.index, sku: line.sku, supplierId: line.resolvedSupplierId })
  }

  return { orderDesignReady: missing.length === 0, lineLinks, missing }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- design-library`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/design-library.ts src/lib/design-library.test.ts
git commit -m "feat(design): guard ready-but-null library links + allowReuse flag"
```

---

### Task 2: `autoDetectStatus` — hasDesignLine

**Files:**
- Modify: `src/lib/pipeline-status.ts:67-94`
- Test: Create `src/lib/pipeline-status.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AutoDetectInput` gains optional `hasDesignLine?: boolean`. `autoDetectStatus` computes the pending-design branch from `(input.hasDesignLine ?? input.hasCustomDesignLine)` — backward compatible with existing callers.

- [ ] **Step 1: Write failing test**

Create `src/lib/pipeline-status.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { autoDetectStatus } from './pipeline-status'

const base = {
  financialStatus: 'PAID', fulfillmentStatus: null,
  hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
}

describe('autoDetectStatus', () => {
  it('hasDesignLine && !designReady => PENDING_DESIGN', () => {
    expect(autoDetectStatus({ ...base, hasDesignLine: true, hasDesignReady: false }))
      .toBe('PENDING_DESIGN')
  })

  it('hasDesignLine && designReady => READY_TO_PRODUCTION', () => {
    expect(autoDetectStatus({ ...base, hasDesignLine: true, hasDesignReady: true }))
      .toBe('READY_TO_PRODUCTION')
  })

  it('falls back to hasCustomDesignLine when hasDesignLine absent', () => {
    expect(autoDetectStatus({ ...base, hasCustomDesignLine: true, hasDesignReady: false }))
      .toBe('PENDING_DESIGN')
  })

  it('pending mapping wins over design', () => {
    expect(autoDetectStatus({ ...base, hasPendingMapping: true, hasDesignLine: true }))
      .toBe('PENDING_MAPPING')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- pipeline-status`
Expected: FAIL — `hasDesignLine` is not read yet.

- [ ] **Step 3: Implement**

In `src/lib/pipeline-status.ts`, add the field to `AutoDetectInput`:

```typescript
export type AutoDetectInput = {
  financialStatus: string
  fulfillmentStatus?: string | null
  hasUnmappedSku: boolean
  hasPendingMapping: boolean
  hasCustomDesignLine: boolean
  hasDesignLine?: boolean
  hasDesignReady?: boolean
  currentStatus?: PipelineStatus | null
}
```

And change the `initial` computation inside `autoDetectStatus`:

```typescript
  const needsDesign = input.hasDesignLine ?? input.hasCustomDesignLine
  const initial: PipelineStatus =
    input.hasPendingMapping || input.hasUnmappedSku ? 'PENDING_MAPPING' :
    needsDesign && !input.hasDesignReady ? 'PENDING_DESIGN' :
    'READY_TO_PRODUCTION'
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- pipeline-status`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline-status.ts src/lib/pipeline-status.test.ts
git commit -m "feat(status): hasDesignLine drives PENDING_DESIGN (backward compatible)"
```

---

### Task 3: Order sync — needs-design trigger, per-type reuse, existing line links

**Files:**
- Modify: `src/app/api/shopify/orders/sync/route.ts` (designInputs ~271-286; hasCustomDesignLine ~266-269; autoDetectStatus call ~289-296; needsCard ~396-402)
- Test: none new (pure logic covered by Tasks 1-2). Verified by typecheck + re-sync.

**Interfaces:**
- Consumes: `resolveOrderDesign(..., { allowReuse })` from Task 1; `autoDetectStatus({ hasDesignLine })` from Task 2.
- Produces: no exported API change.

- [ ] **Step 1: Read existing order-line design links before resolving**

After the existing `const existing = await prisma.order.findUnique(...)` (~line 260), add:

```typescript
      const existingLineLinks = new Map(
        (await prisma.orderLine.findMany({
          where: { orderId: o.id },
          select: { shopifyLineId: true, designDriveLink: true },
        })).map(l => [l.shopifyLineId, l.designDriveLink]),
      )
```

- [ ] **Step 2: Redefine the design trigger + existing link in `designInputs`**

Replace the `designInputs` map (~271-281) so each line needs design when mapped, and carries its current link:

```typescript
      const designInputs: DesignLineInput[] = resolvedLines.map((r, idx) => {
        const sp = r.pbResolve.supplierProductId ? supplierProductById.get(r.pbResolve.supplierProductId) : null
        return {
          index: idx,
          sku: r.line.sku,
          isNonProduct: isNonProductLine({ sku: r.line.sku, productTitle: r.line.title, shopifyProductType: r.line.productType }),
          requiresDesign: !!sp?.supplierId,
          resolvedSupplierId: sp?.supplierId ?? null,
          existingDesignLink: existingLineLinks.get(r.line.id) ?? null,
        }
      })
```

- [ ] **Step 3: Disable library reuse for CUSTOM in the resolve call**

Update the `resolveOrderDesign` call (~282-285):

```typescript
      const designResolution = resolveOrderDesign(designInputs, (sku, supId) => {
        const key = designKey(sku, supId)
        return designLookup.has(key) ? { ready: true, designLink: designLookup.get(key) ?? null } : null
      }, { allowReuse: orderType !== 'CUSTOM' })
```

Note: `orderType` is computed later in the current file (~367). Move the `const orderType = classifyOrderLines(classifyLines)` computation (and its `classifyLines`) to just above this resolve call so it is in scope here. Keep the single later DB-update use of `orderType` working (it stays below).

- [ ] **Step 4: Redefine hasDesignLine and pass it to autoDetectStatus**

Replace `hasCustomDesignLine` (~266-269) with:

```typescript
      const hasDesignLine = designInputs.some(d => !d.isNonProduct && d.requiresDesign)
```

Update the `autoDetectStatus({ ... })` call (~289-296) to pass `hasDesignLine` and keep `hasCustomDesignLine: hasDesignLine` for the existing field:

```typescript
      const detected = autoDetectStatus({
        financialStatus: o.financialStatus,
        hasUnmappedSku: pl.hasUnmappedSku,
        hasPendingMapping,
        hasCustomDesignLine: hasDesignLine,
        hasDesignLine,
        hasDesignReady: effectiveDesignReady,
        currentStatus,
      })
```

- [ ] **Step 5: NON_CUSTOM needsCard already uses `missing`; confirm CUSTOM unchanged**

Verify the `needsCard` block (~396-402) reads:

```typescript
        if (orderType === 'CUSTOM') {
          needsCard = true
        } else if (orderType === 'NON_CUSTOM') {
          needsCard = designResolution.missing.length > 0
        }
```

No change needed — with the new trigger, `missing` is now populated for un-designed NON_CUSTOM SKUs.

- [ ] **Step 6: Typecheck + lint**

Run: `npx tsc --noEmit -p tsconfig.json`
Run: `npm run lint`
Expected: no errors in `src/app/api/shopify/orders/sync/route.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/shopify/orders/sync/route.ts
git commit -m "feat(sync): mapped product line = needs design; CUSTOM no library reuse"
```

---

### Task 4: Multi-line-safe library population (per-SKU file matching)

**Files:**
- Modify: `src/lib/order-line-assets.ts` (add `findDriveAttachmentForSku`)
- Modify: `src/lib/repos/design-library.ts:73-79` (`markLibraryReadyByCard`)
- Modify: `src/app/api/trello/sync/route.ts:31-35, 157-163`
- Test: `src/lib/order-line-assets.test.ts` (create)

**Interfaces:**
- Consumes: `DriveAttachment` from `order-line-assets`.
- Produces:
  - `findDriveAttachmentForSku(sku: string | null | undefined, attachments: DriveAttachment[]): DriveAttachment | null` — returns the Drive attachment whose `name`+`url` (lowercased) contains the lowercased SKU, else null.
  - `markLibraryReadyByCard(cardId: string, attachments: DriveAttachment[]): Promise<number>` — for each `SkuSupplierDesign` row of the card, set `ready=true` + `designLink` only when its SKU matches a Drive file; returns rows updated.

- [ ] **Step 1: Write failing test for the SKU matcher**

Create `src/lib/order-line-assets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { findDriveAttachmentForSku } from './order-line-assets'

const att = (name: string) => ({ name, url: 'https://drive.google.com/file/d/' + name })

describe('findDriveAttachmentForSku', () => {
  it('matches the file whose name contains the sku', () => {
    const files = [att('DN1-11OZ'), att('DN1-15OZ')]
    expect(findDriveAttachmentForSku('DN1-15OZ', files)?.name).toBe('DN1-15OZ')
  })

  it('is case-insensitive', () => {
    expect(findDriveAttachmentForSku('dn1-15oz', [att('DN1-15OZ')])?.name).toBe('DN1-15OZ')
  })

  it('returns null when no file matches', () => {
    expect(findDriveAttachmentForSku('ZZZ', [att('DN1-15OZ')])).toBeNull()
  })

  it('returns null for empty sku', () => {
    expect(findDriveAttachmentForSku('', [att('DN1-15OZ')])).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- order-line-assets`
Expected: FAIL — `findDriveAttachmentForSku` not exported.

- [ ] **Step 3: Implement the matcher**

Append to `src/lib/order-line-assets.ts`:

```typescript
export function findDriveAttachmentForSku(
  sku: string | null | undefined,
  attachments: DriveAttachment[],
): DriveAttachment | null {
  const normalized = (sku ?? '').toLowerCase().trim()
  if (!normalized) return null
  const driveAttachments = attachments.filter(a => a.url.includes('drive.google.com'))
  return driveAttachments.find(a => `${a.name} ${a.url}`.toLowerCase().includes(normalized)) ?? null
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- order-line-assets`
Expected: PASS.

- [ ] **Step 5: Rewrite `markLibraryReadyByCard` to match per SKU**

Replace `markLibraryReadyByCard` in `src/lib/repos/design-library.ts`:

```typescript
import { findDriveAttachmentForSku, type DriveAttachment } from '@/lib/order-line-assets'

export async function markLibraryReadyByCard(cardId: string, attachments: DriveAttachment[]): Promise<number> {
  const rows = await prisma.skuSupplierDesign.findMany({
    where: { trelloCardId: cardId, ready: false },
    select: { id: true, sku: true },
  })
  let updated = 0
  for (const row of rows) {
    const file = findDriveAttachmentForSku(row.sku, attachments)
    if (!file) continue
    await prisma.skuSupplierDesign.update({
      where: { id: row.id },
      data: { ready: true, designLink: file.url },
    })
    updated += 1
  }
  return updated
}
```

- [ ] **Step 6: Update the Trello sync caller**

In `src/app/api/trello/sync/route.ts`:

Replace the call at ~35:

```typescript
    updated += await markLibraryReadyByCard(card.id, driveAttachments)
```

Replace the `SkuDesign` upsert loop (~157-163) so each SKU takes its own matched file (skip unmatched):

```typescript
    for (const sku of skus) {
      const file = findDriveAttachmentForSku(sku, driveAttachments)
      if (!file) continue
      await prisma.skuDesign.upsert({
        where: { sku },
        create: { sku, driveLink: file.url },
        update: { driveLink: file.url },
      })
    }
```

Add `findDriveAttachmentForSku` to the existing import from `@/lib/order-line-assets`.

- [ ] **Step 7: Typecheck + tests**

Run: `npx tsc --noEmit -p tsconfig.json`
Run: `npm test -- order-line-assets design-library`
Expected: no type errors; tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/order-line-assets.ts src/lib/order-line-assets.test.ts src/lib/repos/design-library.ts src/app/api/trello/sync/route.ts
git commit -m "fix(design): per-SKU library population so multi-line cards don't cross-contaminate"
```

---

### Task 5: Export design-link resolution — extract + test

**Files:**
- Modify: `src/app/api/fulfillment/export/route.ts:83-88`
- Create: `src/lib/export-design.ts`
- Test: `src/lib/export-design.test.ts`

**Interfaces:**
- Produces: `pickExportDesignLink(input: { lineDesignLink: string | null; orderDesignLink: string | null; productLineCount: number; orderType: string; sku: string | null; skuDesignLink: string | null }): string | null` — pure form of the current export fallback chain, with the order-level link usable whenever the line lacks its own (not only single-line orders).

- [ ] **Step 1: Write failing tests**

Create `src/lib/export-design.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { pickExportDesignLink } from './export-design'

const inp = (o: Partial<Parameters<typeof pickExportDesignLink>[0]>) => ({
  lineDesignLink: null, orderDesignLink: null, productLineCount: 1,
  orderType: 'NON_CUSTOM', sku: 'S', skuDesignLink: null, ...o,
})

describe('pickExportDesignLink', () => {
  it('prefers the line link', () => {
    expect(pickExportDesignLink(inp({ lineDesignLink: 'L', orderDesignLink: 'O' }))).toBe('L')
  })
  it('uses order link for multi-line when line lacks its own', () => {
    expect(pickExportDesignLink(inp({ orderDesignLink: 'O', productLineCount: 3 }))).toBe('O')
  })
  it('falls back to SkuDesign for NON_CUSTOM', () => {
    expect(pickExportDesignLink(inp({ skuDesignLink: 'M' }))).toBe('M')
  })
  it('does not use SkuDesign for CUSTOM', () => {
    expect(pickExportDesignLink(inp({ orderType: 'CUSTOM', skuDesignLink: 'M' }))).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- export-design`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/lib/export-design.ts`:

```typescript
export function pickExportDesignLink(input: {
  lineDesignLink: string | null
  orderDesignLink: string | null
  productLineCount: number
  orderType: string
  sku: string | null
  skuDesignLink: string | null
}): string | null {
  return (
    input.lineDesignLink ??
    input.orderDesignLink ??
    (input.orderType !== 'CUSTOM' && input.sku ? input.skuDesignLink : null) ??
    null
  )
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- export-design`
Expected: PASS.

- [ ] **Step 5: Wire the export route to use it**

In `src/app/api/fulfillment/export/route.ts`, replace the inline `designDriveLink` chain (~85-88) with:

```typescript
          const designDriveLink = pickExportDesignLink({
            lineDesignLink: l.designDriveLink,
            orderDesignLink: o.designDriveLink,
            productLineCount: productLines.length,
            orderType: o.orderType,
            sku: l.sku,
            skuDesignLink: l.sku ? skuDesignBySku.get(l.sku)?.driveLink ?? null : null,
          })
```

Add `import { pickExportDesignLink } from '@/lib/export-design'` at the top.

- [ ] **Step 6: Typecheck + tests**

Run: `npx tsc --noEmit -p tsconfig.json`
Run: `npm test -- export-design`
Expected: no type errors; PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/export-design.ts src/lib/export-design.test.ts src/app/api/fulfillment/export/route.ts
git commit -m "refactor(export): extract+test design-link pick; order link works for multi-line"
```

---

### Task 6: Backfill script for broken orders

**Files:**
- Create: `scripts/backfill-design-cards.mjs`

**Interfaces:**
- CLI: `node scripts/backfill-design-cards.mjs [--apply]`. Default is dry-run (prints the plan, no writes, no Trello calls). `--apply` performs writes.

- [ ] **Step 1: Write the script**

Create `scripts/backfill-design-cards.mjs`:

```javascript
import { createClient } from '@libsql/client'
import path from 'path'

const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const apply = process.argv.includes('--apply')
const db = createClient({ url })

// Broken = designReady but no design link anywhere, with at least one mapped supplier line.
const broken = await db.execute({
  sql: `
    SELECT o.id, o.shopifyOrderNumber, o.orderType, o.pipelineStatus, o.fulfillmentStatus
    FROM "Order" o
    WHERE o.designReady = 1
      AND o.designDriveLink IS NULL
      AND NOT EXISTS (SELECT 1 FROM "OrderLine" l WHERE l.orderId = o.id AND l.designDriveLink IS NOT NULL)
      AND EXISTS (SELECT 1 FROM "OrderLine" l WHERE l.orderId = o.id AND l.resolvedSupplierId IS NOT NULL)
    ORDER BY o.placedAt DESC`,
  args: [],
})

const terminal = new Set(['FULFILLED', 'CANCELLED', 'REFUNDED', 'fulfilled'])
let resettable = 0
console.log(`Found ${broken.rows.length} broken orders (designReady, no link).`)
for (const o of broken.rows) {
  const isFulfilled = (o.fulfillmentStatus ?? '').toLowerCase() === 'fulfilled'
  const willReset = !terminal.has(o.pipelineStatus) && !isFulfilled
  if (willReset) resettable += 1
  console.log(`${o.shopifyOrderNumber} [${o.orderType}/${o.pipelineStatus}] resetToPendingDesign=${willReset}`)
  if (apply && willReset) {
    await db.execute({
      sql: `UPDATE "Order" SET designReady = 0, designDriveLink = NULL, pipelineStatus = 'PENDING_DESIGN' WHERE id = ?`,
      args: [o.id],
    })
  }
}
console.log(`\n${apply ? 'APPLIED' : 'DRY-RUN'}: ${resettable} orders ${apply ? 'reset' : 'would reset'} to PENDING_DESIGN.`)
console.log('Next: run the order sync so PENDING_DESIGN orders create Trello cards for un-designed SKUs.')
```

- [ ] **Step 2: Dry-run locally (safe, no writes)**

Run: `node scripts/backfill-design-cards.mjs`
Expected: prints the list and a dry-run summary. (Local dev.db may show 0; the real run is against prod — see Step 3.)

- [ ] **Step 3: Dry-run against prod (read-only), then confirm before --apply**

Copy to VPS and dry-run:

```bash
scp -i ~/.ssh/ecommanager_vps_ed25519 scripts/backfill-design-cards.mjs root@178.105.170.0:/home/podmanager/backfill-design-cards.mjs
ssh -i ~/.ssh/ecommanager_vps_ed25519 root@178.105.170.0 'cd /home/podmanager && node backfill-design-cards.mjs'
```

Expected: lists ~38 broken orders. **Do not pass `--apply` until the human reviews the dry-run.** Card creation happens on the next order sync (the existing sync path), not in this script.

- [ ] **Step 4: Commit the script**

```bash
git add scripts/backfill-design-cards.mjs
git commit -m "chore(design): backfill script to reset falsely-ready orders to PENDING_DESIGN"
```

---

### Task 7: Clean up throwaway diagnostics

**Files:**
- Delete: `scripts/diag-order.mjs`, `scripts/diag-design.mjs`, `scripts/diag-supplier.mjs`
- Keep: `src/app/api/fulfillment/design-diagnose/route.ts` (read-only support tool)

- [ ] **Step 1: Remove local diag scripts**

```bash
git rm -f --ignore-unmatch scripts/diag-order.mjs scripts/diag-design.mjs scripts/diag-supplier.mjs 2>$null
rm -f scripts/diag-order.mjs scripts/diag-design.mjs scripts/diag-supplier.mjs
```

- [ ] **Step 2: Full test suite + typecheck**

Run: `npm test`
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add -A scripts/
git commit -m "chore: remove throwaway design diagnostics; keep design-diagnose route"
```

---

## Self-Review

**Spec coverage:**
- Reuse key full SKU+supplier → unchanged keying (Tasks 1, 3, 4). ✓
- Needs-design = mapped product line → Task 3 Step 2. ✓
- NON_CUSTOM reuse / first-time card → Task 3 (trigger + needsCard) + existing card path. ✓
- CUSTOM no reuse, always card, PENDING_DESIGN → Task 1 (allowReuse) + Task 3 (allowReuse:false) + Task 2 (hasDesignLine). ✓
- Multi-line each own file / library not cross-contaminated → Task 4. ✓
- Fix orderDesignReady default-true → Task 1 (missing-based) + Task 3 (mapped lines become design lines). ✓
- Export blank fix → Tasks 3/4 populate line links; Task 5 hardens the fallback. ✓
- Backfill 38 orders → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete code. ✓

**Type consistency:** `resolveOrderDesign(lines, lookup, { allowReuse })`, `findDriveAttachmentForSku(sku, attachments)`, `markLibraryReadyByCard(cardId, attachments)`, `pickExportDesignLink({...})`, `AutoDetectInput.hasDesignLine` — names used consistently across tasks. ✓

**Note for executor:** In Task 3, `orderType` is currently computed lower in the file; move its computation above the `resolveOrderDesign` call so it is in scope (and confirm the later `orderType` DB-update still compiles).
