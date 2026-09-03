# Design Library v2 (Parent Code + DUAL + Task Queue) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse designs by parent design code (not full SKU), support DUAL (custom-or-not) products with per-line detection, expose missing designs as a completable task queue, and re-evaluate order type every sync.

**Architecture:** Evolve the existing `SkuSupplierDesign` library: add `parentCode` + `designType`, match order lines by parent code contained in the SKU (longest wins, supplier-scoped). Classification becomes per-line (customized = `_print_files` or `previewCdnUrl`) and the order type is reduced to NON_CUSTOM/CUSTOM/DUAL/MIXED on every sync (no longer sticky). Missing non-custom designs auto-create `ready=false` task rows completed on the design-library page.

**Tech Stack:** Next.js 14 API routes, Prisma 7 + libSQL (SQLite), vitest, React client pages, Trello REST.

**Spec:** `docs/superpowers/specs/2026-09-03-design-library-parent-dual.md`

## Global Constraints

- Import prisma via `import { prisma } from '@/lib/db'`. Never import from `@/generated/prisma` directly (use `@/generated/prisma/client`).
- After ANY schema change: `npx prisma migrate dev --name <desc>` → `npx prisma generate` → bump `SCHEMA_VERSION` in `src/lib/db.ts` → restart dev server (per CLAUDE.md).
- Never add `url` to the `datasource db {}` block in `prisma/schema.prisma`.
- Tests: `npm test` (vitest); test files sit next to source as `*.test.ts`.
- Reuse key = **parent design code + supplierId**. Parent code is user-owned; the auto-suggestion is `sku.split('-')[0]`.
- A line is "customized" ⟺ it has a `_print_files` custom attribute OR a non-empty `previewCdnUrl`.
- Order type values: `NON_CUSTOM | CUSTOM | DUAL | MIXED | UNKNOWN`. Re-evaluated every sync (not sticky).
- Design types: `NON_CUSTOM | CUSTOM | DUAL`.
- 2 pre-existing failures in `order-profit.test.ts` are unrelated — leave that file untouched.

---

### Task 1: Parent-code utilities

**Files:**
- Create: `src/lib/design-parent.ts`
- Test: `src/lib/design-parent.test.ts`

**Interfaces:**
- Produces:
  - `suggestParentCode(sku: string | null | undefined): string` — the auto-suggested parent = text before the first `-`, trimmed (empty string if none).
  - `type ParentEntry = { parentCode: string; supplierId: string; designLink: string | null; designType: string }`
  - `matchParentEntry(sku: string | null | undefined, supplierId: string | null | undefined, entries: ParentEntry[]): ParentEntry | null` — the entry whose lowercased `parentCode` is a prefix of the lowercased SKU and whose `supplierId` matches; when several match, the one with the LONGEST `parentCode` wins; null if none or empty inputs.

- [ ] **Step 1: Write failing tests**

Create `src/lib/design-parent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { suggestParentCode, matchParentEntry, type ParentEntry } from './design-parent'

const e = (parentCode: string, over: Partial<ParentEntry> = {}): ParentEntry => ({
  parentCode, supplierId: 'supA', designLink: 'L', designType: 'NON_CUSTOM', ...over,
})

describe('suggestParentCode', () => {
  it('takes text before the first dash', () => {
    expect(suggestParentCode('SW15051601-3XL')).toBe('SW15051601')
    expect(suggestParentCode('DN1408261642-ACCENT-MUG-15OZ, RED')).toBe('DN1408261642')
  })
  it('returns whole sku when no dash', () => {
    expect(suggestParentCode('823558')).toBe('823558')
  })
  it('empty for null/empty', () => {
    expect(suggestParentCode(null)).toBe('')
    expect(suggestParentCode('')).toBe('')
  })
})

describe('matchParentEntry', () => {
  it('matches when parentCode is a prefix of the sku (case-insensitive), same supplier', () => {
    const m = matchParentEntry('SW15051601-3XL', 'supA', [e('sw15051601')])
    expect(m?.parentCode).toBe('sw15051601')
  })
  it('does not match a different supplier', () => {
    expect(matchParentEntry('SW15051601-3XL', 'supB', [e('SW15051601', { supplierId: 'supA' })])).toBeNull()
  })
  it('prefers the longest matching parentCode', () => {
    const m = matchParentEntry('DN15041511-TS', 'supA', [e('DN15'), e('DN15041511')])
    expect(m?.parentCode).toBe('DN15041511')
  })
  it('null when nothing matches or inputs empty', () => {
    expect(matchParentEntry('ABC-1', 'supA', [e('ZZZ')])).toBeNull()
    expect(matchParentEntry(null, 'supA', [e('ABC')])).toBeNull()
    expect(matchParentEntry('ABC-1', null, [e('ABC')])).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- design-parent`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/lib/design-parent.ts`:

```typescript
export function suggestParentCode(sku: string | null | undefined): string {
  const s = (sku ?? '').trim()
  if (!s) return ''
  const dash = s.indexOf('-')
  return (dash === -1 ? s : s.slice(0, dash)).trim()
}

export type ParentEntry = {
  parentCode: string
  supplierId: string
  designLink: string | null
  designType: string
}

export function matchParentEntry(
  sku: string | null | undefined,
  supplierId: string | null | undefined,
  entries: ParentEntry[],
): ParentEntry | null {
  const s = (sku ?? '').toLowerCase().trim()
  if (!s || !supplierId) return null
  let best: ParentEntry | null = null
  for (const entry of entries) {
    const pc = (entry.parentCode ?? '').toLowerCase().trim()
    if (!pc || entry.supplierId !== supplierId) continue
    if (!s.startsWith(pc)) continue
    if (!best || pc.length > best.parentCode.toLowerCase().trim().length) best = entry
  }
  return best
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- design-parent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/design-parent.ts src/lib/design-parent.test.ts
git commit -m "feat(design): parent-code suggest + longest-prefix matcher"
```

---

### Task 2: Per-line custom detection + order-type reduction

**Files:**
- Modify: `src/lib/order-classify.ts`
- Test: `src/lib/order-classify.test.ts` (extend if present, else create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `isLineCustomized(line: { customAttributes: Array<{key:string;value:string}>; previewCdnUrl?: string | null }): boolean` — true if a `_print_files` attribute exists or `previewCdnUrl` is non-empty.
  - `type LineFamily = 'CUSTOM' | 'DUAL' | 'NON_CUSTOM'`
  - `lineFamily(input: { customized: boolean; designType: string }): LineFamily` — customized → `CUSTOM`; else DUAL designType → `DUAL`; else `NON_CUSTOM`.
  - `reduceOrderType(families: LineFamily[]): 'NON_CUSTOM'|'CUSTOM'|'DUAL'|'MIXED'|'UNKNOWN'` — empty → `UNKNOWN`; single distinct family → that family; ≥2 distinct → `MIXED`.
  - Keep existing `classifyOrderLines` and `buildTrelloCardContent` exports unchanged.

- [ ] **Step 1: Write failing tests**

Create/extend `src/lib/order-classify.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest'
import { isLineCustomized, lineFamily, reduceOrderType } from './order-classify'

describe('isLineCustomized', () => {
  it('true when _print_files present', () => {
    expect(isLineCustomized({ customAttributes: [{ key: '_print_files', value: '[]' }] })).toBe(true)
  })
  it('true when previewCdnUrl present', () => {
    expect(isLineCustomized({ customAttributes: [], previewCdnUrl: 'http://p' })).toBe(true)
  })
  it('false otherwise', () => {
    expect(isLineCustomized({ customAttributes: [{ key: 'Size', value: 'M' }], previewCdnUrl: null })).toBe(false)
  })
})

describe('lineFamily', () => {
  it('customized => CUSTOM regardless of type', () => {
    expect(lineFamily({ customized: true, designType: 'DUAL' })).toBe('CUSTOM')
  })
  it('DUAL type not customized => DUAL', () => {
    expect(lineFamily({ customized: false, designType: 'DUAL' })).toBe('DUAL')
  })
  it('otherwise NON_CUSTOM', () => {
    expect(lineFamily({ customized: false, designType: 'NON_CUSTOM' })).toBe('NON_CUSTOM')
  })
})

describe('reduceOrderType', () => {
  it('empty => UNKNOWN', () => { expect(reduceOrderType([])).toBe('UNKNOWN') })
  it('all same => that family', () => {
    expect(reduceOrderType(['NON_CUSTOM', 'NON_CUSTOM'])).toBe('NON_CUSTOM')
    expect(reduceOrderType(['DUAL'])).toBe('DUAL')
    expect(reduceOrderType(['CUSTOM', 'CUSTOM'])).toBe('CUSTOM')
  })
  it('mixed families => MIXED', () => {
    expect(reduceOrderType(['CUSTOM', 'NON_CUSTOM'])).toBe('MIXED')
    expect(reduceOrderType(['DUAL', 'NON_CUSTOM'])).toBe('MIXED')
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- order-classify`
Expected: FAIL (new exports missing).

- [ ] **Step 3: Implement**

Append to `src/lib/order-classify.ts`:

```typescript
export function isLineCustomized(line: {
  customAttributes: Array<{ key: string; value: string }>
  previewCdnUrl?: string | null
}): boolean {
  if (line.customAttributes.some(a => a.key === '_print_files')) return true
  return !!(line.previewCdnUrl && line.previewCdnUrl.trim())
}

export type LineFamily = 'CUSTOM' | 'DUAL' | 'NON_CUSTOM'

export function lineFamily(input: { customized: boolean; designType: string }): LineFamily {
  if (input.customized) return 'CUSTOM'
  if (input.designType === 'DUAL') return 'DUAL'
  return 'NON_CUSTOM'
}

export function reduceOrderType(
  families: LineFamily[],
): 'NON_CUSTOM' | 'CUSTOM' | 'DUAL' | 'MIXED' | 'UNKNOWN' {
  if (families.length === 0) return 'UNKNOWN'
  const distinct = Array.from(new Set(families))
  if (distinct.length === 1) return distinct[0]
  return 'MIXED'
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- order-classify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/order-classify.ts src/lib/order-classify.test.ts
git commit -m "feat(classify): per-line custom detection + order-type reduction (DUAL/MIXED)"
```

---

### Task 3: Schema — parentCode + designType on SkuSupplierDesign

**Files:**
- Modify: `prisma/schema.prisma` (model `SkuSupplierDesign`, ~lines 475-488)
- Modify: `src/lib/db.ts` (bump `SCHEMA_VERSION`)

**Interfaces:**
- Produces: `SkuSupplierDesign.parentCode String?` and `SkuSupplierDesign.designType String @default("NON_CUSTOM")`, plus an index `@@index([parentCode, supplierId])`. The existing `@@unique([sku, supplierId])` stays (per-SKU rows still allowed; dedupe happens in Task 9).

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, inside `model SkuSupplierDesign`, add after `note String?`:

```prisma
  parentCode   String?
  designType   String   @default("NON_CUSTOM")   // "NON_CUSTOM" | "CUSTOM" | "DUAL"
```

And add an index line before the closing `}` (alongside `@@unique([sku, supplierId])`):

```prisma
  @@index([parentCode, supplierId])
```

- [ ] **Step 2: Run migration + generate**

Run (from repo root):
```bash
npx prisma migrate dev --name design_library_parent_type
npx prisma generate
```
Expected: migration applies cleanly; client regenerates with the new fields.

- [ ] **Step 3: Bump SCHEMA_VERSION**

In `src/lib/db.ts`, change `const SCHEMA_VERSION = 'v39'` to the next version (`'v40'`).

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors (fields optional/defaulted so existing code compiles).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts
git commit -m "feat(schema): SkuSupplierDesign parentCode + designType"
```

---

### Task 4: Repo — parent lookup, list/upsert fields, task upsert

**Files:**
- Modify: `src/lib/repos/design-library.ts`
- Test: `src/lib/repos/design-library.parent.test.ts` (create — pure helper only; DB calls not unit-tested)

**Interfaces:**
- Consumes: `ParentEntry` (Task 1), Prisma model fields (Task 3).
- Produces:
  - `loadReadyParentLookup(): Promise<ParentEntry[]>` — ready entries that have a `parentCode` and `designLink`, mapped to `{parentCode, supplierId, designLink, designType}`.
  - `upsertDesignEntry` extended to accept `parentCode?: string | null` and `designType?: string`.
  - `listDesignEntries` result includes `parentCode` and `designType` (they are model fields, already returned by `findMany`).
  - `upsertTaskEntry(input: { sku: string; supplierId: string; parentCode: string; trelloCardId?: string | null }): Promise<void>` — creates a `ready=false` task row for `(sku, supplierId)` if no row exists; sets `parentCode`, `source='TRELLO'`. Never overwrites an existing ready row.
  - `pickParent(entry: { parentCode: string | null; sku: string }): string` — returns `entry.parentCode` or `suggestParentCode(entry.sku)`.

- [ ] **Step 1: Write failing test for `pickParent`**

Create `src/lib/repos/design-library.parent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { pickParent } from './design-library'

describe('pickParent', () => {
  it('uses explicit parentCode when set', () => {
    expect(pickParent({ parentCode: 'DN15041511', sku: 'DN15041511-TS' })).toBe('DN15041511')
  })
  it('falls back to suggestion from sku', () => {
    expect(pickParent({ parentCode: null, sku: 'DN15041511-TS' })).toBe('DN15041511')
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- design-library.parent`
Expected: FAIL (`pickParent` not exported).

- [ ] **Step 3: Implement**

In `src/lib/repos/design-library.ts`:

Add imports at top:
```typescript
import { suggestParentCode, type ParentEntry } from '@/lib/design-parent'
```

Add exported helpers:
```typescript
export function pickParent(entry: { parentCode: string | null; sku: string }): string {
  return (entry.parentCode && entry.parentCode.trim()) || suggestParentCode(entry.sku)
}

export async function loadReadyParentLookup(): Promise<ParentEntry[]> {
  const rows = await prisma.skuSupplierDesign.findMany({
    where: { ready: true },
    select: { sku: true, parentCode: true, supplierId: true, designLink: true, designType: true },
  })
  return rows
    .filter(r => r.designLink)
    .map(r => ({
      parentCode: pickParent({ parentCode: r.parentCode, sku: r.sku }),
      supplierId: r.supplierId,
      designLink: r.designLink,
      designType: r.designType,
    }))
    .filter(r => r.parentCode)
}

export async function upsertTaskEntry(input: {
  sku: string; supplierId: string; parentCode: string; trelloCardId?: string | null
}): Promise<void> {
  const existing = await prisma.skuSupplierDesign.findUnique({
    where: { sku_supplierId: { sku: input.sku, supplierId: input.supplierId } },
    select: { id: true, ready: true },
  })
  if (existing) return // never clobber an existing (ready or task) row
  await prisma.skuSupplierDesign.create({
    data: {
      sku: input.sku, supplierId: input.supplierId, parentCode: input.parentCode,
      ready: false, source: 'TRELLO', trelloCardId: input.trelloCardId ?? null,
      designType: 'NON_CUSTOM',
    },
  })
}
```

Extend `upsertDesignEntry`'s input type and create/update data with `parentCode` and `designType`:
```typescript
export async function upsertDesignEntry(input: {
  sku: string; supplierId: string; designLink?: string | null;
  ready?: boolean; note?: string | null; source?: string; trelloCardId?: string | null;
  parentCode?: string | null; designType?: string
}) {
  const ready = input.ready ?? (input.designLink ? true : false)
  return prisma.skuSupplierDesign.upsert({
    where: { sku_supplierId: { sku: input.sku, supplierId: input.supplierId } },
    create: {
      sku: input.sku, supplierId: input.supplierId,
      designLink: input.designLink ?? null, ready,
      note: input.note ?? null, source: input.source ?? 'MANUAL',
      trelloCardId: input.trelloCardId ?? null,
      parentCode: input.parentCode ?? null,
      designType: input.designType ?? 'NON_CUSTOM',
    },
    update: {
      ...(input.designLink !== undefined ? { designLink: input.designLink } : {}),
      ...(input.ready !== undefined ? { ready: input.ready } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.trelloCardId !== undefined ? { trelloCardId: input.trelloCardId } : {}),
      ...(input.parentCode !== undefined ? { parentCode: input.parentCode } : {}),
      ...(input.designType !== undefined ? { designType: input.designType } : {}),
    },
  })
}
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `npm test -- design-library.parent`
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: test PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/repos/design-library.ts src/lib/repos/design-library.parent.test.ts
git commit -m "feat(design-repo): parent lookup, task upsert, parentCode/designType fields"
```

---

### Task 5: resolveOrderDesign — parent match + DUAL per-line

**Files:**
- Modify: `src/lib/design-library.ts`
- Test: `src/lib/design-library.test.ts` (extend)

**Interfaces:**
- Consumes: `matchParentEntry`, `ParentEntry` (Task 1).
- Produces: `resolveOrderDesignByParent(lines, parentEntries): DesignResolution` where each `DesignLineInput` gains `customized: boolean`. Rules per design line (`!isNonProduct && requiresDesign`):
  - `existingDesignLink` present → satisfied (keep it).
  - `customized === true` → missing (needs its own per-order card; never reuse).
  - else parent match with a `designLink` → reuse (push lineLink).
  - else → missing.
  `orderDesignReady = missing.length === 0`. Keep the existing `resolveOrderDesign` for back-compat.

- [ ] **Step 1: Write failing tests**

Add to `src/lib/design-library.test.ts`:

```typescript
import { resolveOrderDesignByParent } from './design-library'

const pLine = (over: Partial<any> = {}) => ({
  index: 0, sku: 'DN15041511-TS', isNonProduct: false, requiresDesign: true,
  resolvedSupplierId: 'supA', existingDesignLink: null, customized: false, ...over,
})
const parents = [{ parentCode: 'DN15041511', supplierId: 'supA', designLink: 'L', designType: 'NON_CUSTOM' }]

describe('resolveOrderDesignByParent', () => {
  it('reuses by parent code for a non-customized line', () => {
    const r = resolveOrderDesignByParent([pLine()], parents)
    expect(r.orderDesignReady).toBe(true)
    expect(r.lineLinks).toEqual([{ index: 0, designLink: 'L' }])
  })
  it('customized line is missing even if parent has a design', () => {
    const r = resolveOrderDesignByParent([pLine({ customized: true })], parents)
    expect(r.orderDesignReady).toBe(false)
    expect(r.missing).toEqual([{ index: 0, sku: 'DN15041511-TS', supplierId: 'supA' }])
  })
  it('no parent match => missing', () => {
    const r = resolveOrderDesignByParent([pLine({ sku: 'ZZZ-1' })], parents)
    expect(r.orderDesignReady).toBe(false)
  })
  it('own existing link wins', () => {
    const r = resolveOrderDesignByParent([pLine({ existingDesignLink: 'own', customized: true })], parents)
    expect(r.orderDesignReady).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- design-library`
Expected: FAIL (`resolveOrderDesignByParent` missing).

- [ ] **Step 3: Implement**

In `src/lib/design-library.ts` add (do NOT remove `resolveOrderDesign`):

```typescript
import { matchParentEntry, type ParentEntry } from '@/lib/design-parent'

export type DesignLineInputV2 = DesignLineInput & { customized: boolean }

export function resolveOrderDesignByParent(
  lines: DesignLineInputV2[],
  parentEntries: ParentEntry[],
): DesignResolution {
  const designLines = lines.filter(l => !l.isNonProduct && l.requiresDesign)
  const lineLinks: DesignResolution['lineLinks'] = []
  const missing: DesignResolution['missing'] = []
  for (const line of designLines) {
    if (line.existingDesignLink) continue
    if (line.customized) {
      missing.push({ index: line.index, sku: line.sku, supplierId: line.resolvedSupplierId })
      continue
    }
    const entry = matchParentEntry(line.sku, line.resolvedSupplierId, parentEntries)
    if (entry && entry.designLink) {
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
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/design-library.ts src/lib/design-library.test.ts
git commit -m "feat(design): resolveOrderDesignByParent (parent reuse + DUAL per-line)"
```

---

### Task 6: Sync route — non-sticky order type, parent reuse, auto-task

**Files:**
- Modify: `src/app/api/shopify/orders/sync/route.ts`

**Interfaces:**
- Consumes: `loadReadyParentLookup`, `upsertTaskEntry` (Task 4); `resolveOrderDesignByParent`, `DesignLineInputV2` (Task 5); `isLineCustomized`, `lineFamily`, `reduceOrderType`, `suggestParentCode` (Tasks 1-2).
- Produces: no exported API change.

- [ ] **Step 1: Load the parent lookup once**

Near the existing `const designLookup = await loadReadyDesignLookup()` (~line 164), add:
```typescript
      const parentEntries = await loadReadyParentLookup()
```
(Keep the old `designLookup` for now; it is superseded but harmless.)

- [ ] **Step 2: Build V2 design inputs with `customized`**

Replace the `designInputs` map so each input carries `customized` and use the parent resolver:
```typescript
      const designInputs: DesignLineInputV2[] = resolvedLines.map((r, idx) => {
        const sp = r.pbResolve.supplierProductId ? supplierProductById.get(r.pbResolve.supplierProductId) : null
        return {
          index: idx,
          sku: r.line.sku,
          isNonProduct: isNonProductLine({ sku: r.line.sku, productTitle: r.line.title, shopifyProductType: r.line.productType }),
          requiresDesign: !!sp?.supplierId,
          resolvedSupplierId: sp?.supplierId ?? null,
          existingDesignLink: existingLineLinks.get(r.line.id) ?? null,
          customized: isLineCustomized({ customAttributes: r.line.customAttributes, previewCdnUrl: extractPreviewCdnUrl(r.line.customAttributes) }),
        }
      })
      const designResolution = resolveOrderDesignByParent(designInputs, parentEntries)
```
(Remove the previous `resolveOrderDesign(...)` call for this order.)

- [ ] **Step 3: Compute order type from line families (non-sticky) and persist every sync**

Replace the sticky block (`if (existingOrder && existingOrder.orderType === 'UNKNOWN') { ... }`, ~line 376-377) with a per-line family reduction that always writes:
```typescript
      const orderType = reduceOrderType(
        designInputs
          .filter(d => !d.isNonProduct && d.requiresDesign)
          .map(d => lineFamily({ customized: d.customized, designType: parentDesignType(d, parentEntries) })),
      )
      await prisma.order.update({ where: { id: o.id }, data: { orderType } })
```
Add a small local helper near the top of the file (module scope):
```typescript
function parentDesignType(d: { sku: string | null; resolvedSupplierId: string | null }, entries: import('@/lib/design-parent').ParentEntry[]): string {
  const m = matchParentEntry(d.sku, d.resolvedSupplierId, entries)
  return m?.designType ?? 'NON_CUSTOM'
}
```
Note: `orderType` is now computed here and used later by the card block — ensure the earlier `const orderType = classifyOrderLines(...)` line added in the prior feature is removed so `orderType` is declared exactly once (this new computation replaces it). Keep `{ allowReuse: ... }` usages consistent: the parent resolver already encodes reuse, so drop the old `resolveOrderDesign(..., {allowReuse})` call entirely.

- [ ] **Step 4: Auto-create task rows for missing non-custom designs**

After `designResolution` is computed and the order is upserted, for each missing line that is NOT customized, create a task:
```typescript
      for (const m of designResolution.missing) {
        const li = designInputs[m.index]
        if (!li || li.customized || !m.sku || !m.supplierId) continue
        await upsertTaskEntry({
          sku: m.sku, supplierId: m.supplierId,
          parentCode: suggestParentCode(m.sku),
          trelloCardId: existingOrder?.trelloCardId ?? null,
        })
      }
```
(Place this alongside the existing card-creation block; card creation itself is unchanged.)

- [ ] **Step 5: Fix imports**

Ensure the top of the file imports: `loadReadyParentLookup`, `upsertTaskEntry` from `@/lib/repos/design-library`; `resolveOrderDesignByParent`, `type DesignLineInputV2` from `@/lib/design-library`; `isLineCustomized`, `lineFamily`, `reduceOrderType` from `@/lib/order-classify`; `suggestParentCode`, `matchParentEntry` from `@/lib/design-parent`.

- [ ] **Step 6: Typecheck + full tests**

Run: `npx tsc --noEmit -p tsconfig.json`
Run: `npm test`
Expected: no type errors; only the 2 pre-existing `order-profit.test.ts` failures remain.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/shopify/orders/sync/route.ts
git commit -m "feat(sync): non-sticky order type (DUAL/MIXED), parent reuse, auto-task creation"
```

---

### Task 7: design-status.ts — honor reuse + link presence

**Files:**
- Modify: `src/lib/design-status.ts`
- Test: `src/lib/design-status.test.ts` (extend if present, else create)

**Interfaces:**
- Produces: `lineDesignStatus` gains a rule so a line with any `designDriveLink` shows `DONE` even without a preview; a non-customized line whose parent has a ready design shows `LIBRARY`.

- [ ] **Step 1: Write failing tests**

Add to `src/lib/design-status.test.ts`:

```typescript
import { lineDesignStatus } from './design-status'

describe('lineDesignStatus link presence', () => {
  it('DONE when the line has a designDriveLink even without preview', () => {
    expect(lineDesignStatus({ isNonProduct: false, previewCdnUrl: null, designDriveLink: 'L', hasLibraryDesign: false })).toBe('DONE')
  })
  it('LIBRARY when non-customized and library has a ready design', () => {
    expect(lineDesignStatus({ isNonProduct: false, previewCdnUrl: null, designDriveLink: null, hasLibraryDesign: true })).toBe('LIBRARY')
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- design-status`
Expected: FAIL (first case currently returns NONE).

- [ ] **Step 3: Implement**

Edit `lineDesignStatus` in `src/lib/design-status.ts`:

```typescript
export function lineDesignStatus(input: {
  isNonProduct: boolean
  previewCdnUrl?: string | null
  designDriveLink?: string | null
  hasLibraryDesign: boolean
}): LineDesignStatus {
  if (input.isNonProduct) return 'NONE'
  if (input.designDriveLink) return 'DONE'
  const isCustomized = !!input.previewCdnUrl
  if (isCustomized) return 'PENDING'
  if (input.hasLibraryDesign) return 'LIBRARY'
  return 'NONE'
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- design-status`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/design-status.ts src/lib/design-status.test.ts
git commit -m "fix(design-status): DONE when line has a link; LIBRARY for parent-ready"
```

---

### Task 8: Design Library UI + API — parentCode, designType, status

**Files:**
- Modify: `src/app/api/fulfillment/design-library/route.ts`
- Modify: `src/app/fulfillment/design-library/page.tsx`

**Interfaces:**
- Consumes: `upsertDesignEntry` extended (Task 4).
- Produces: the POST accepts `parentCode` and `designType`; the page renders/edits `parentCode`, `designType` (select NON_CUSTOM/CUSTOM/DUAL), and a Task/Ready status badge.

- [ ] **Step 1: Extend the POST route**

In `src/app/api/fulfillment/design-library/route.ts`, pass the new fields through:
```typescript
  const entry = await upsertDesignEntry({
    sku: String(body.sku).trim(),
    supplierId: String(body.supplierId),
    designLink: body.designLink ?? null,
    ready: typeof body.ready === 'boolean' ? body.ready : undefined,
    note: body.note ?? null,
    source: 'MANUAL',
    parentCode: body.parentCode !== undefined ? (body.parentCode ? String(body.parentCode).trim() : null) : undefined,
    designType: body.designType !== undefined ? String(body.designType) : undefined,
  })
```

- [ ] **Step 2: Render the new columns on the page**

In `src/app/fulfillment/design-library/page.tsx`:
- Add `parentCode` and `designType` to the row type and the table columns.
- Add a `Status` badge: `entry.ready ? 'Ready' : 'Task'`.
- Add an editable text input for `parentCode` and a `<select>` for `designType` with options `NON_CUSTOM | CUSTOM | DUAL`, plus a Save button that POSTs `{ sku, supplierId, parentCode, designType, designLink, ready }` to `/api/fulfillment/design-library` and refreshes.
- Add a filter toggle to show only tasks (`ready=false`) using the existing `ready` query param.

Follow the existing card/table patterns in this file (`bg-surface-container-lowest rounded-xl`, `material-symbols-outlined`). Reuse the existing fetch + state hooks in the page; do not introduce a new data layer.

- [ ] **Step 3: Typecheck + manual smoke**

Run: `npx tsc --noEmit -p tsconfig.json`
Run: `npm run dev -- --port 3002`, open `/fulfillment/design-library`, confirm columns render, editing parentCode/designType saves and persists after refresh, and the "tasks only" filter works.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/fulfillment/design-library/route.ts src/app/fulfillment/design-library/page.tsx
git commit -m "feat(design-library-ui): parentCode + designType + task/ready status"
```

---

### Task 9: Migration script — derive parent + merge duplicates

**Files:**
- Create: `scripts/migrate-design-parent.mjs`

**Interfaces:**
- CLI: `node scripts/migrate-design-parent.mjs [--apply]` — dry-run by default.

- [ ] **Step 1: Write the script**

Create `scripts/migrate-design-parent.mjs`:

```javascript
import { createClient } from '@libsql/client'
import path from 'path'

const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const apply = process.argv.includes('--apply')
const db = createClient({ url })
const parentOf = (sku) => { const s = String(sku ?? '').trim(); const i = s.indexOf('-'); return (i === -1 ? s : s.slice(0, i)).trim() }

const rows = (await db.execute({ sql: `SELECT id, sku, supplierId, parentCode, designLink, ready, designType FROM "SkuSupplierDesign"`, args: [] })).rows

// 1) backfill parentCode where null
let setParent = 0
for (const r of rows) {
  if (!r.parentCode) {
    setParent++
    if (apply) await db.execute({ sql: `UPDATE "SkuSupplierDesign" SET parentCode=? WHERE id=?`, args: [parentOf(r.sku), r.id] })
  }
}

// 2) find duplicate (parentCode, supplierId) groups; keep the ready+link row, else the first
const groups = new Map()
for (const r of rows) {
  const key = `${r.parentCode || parentOf(r.sku)}::${r.supplierId}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}
let dupGroups = 0, toDelete = []
for (const [key, list] of groups) {
  if (list.length < 2) continue
  dupGroups++
  const keep = list.find(x => x.ready && x.designLink) || list[0]
  for (const x of list) if (x.id !== keep.id) toDelete.push({ id: x.id, key })
}

console.log(`rows=${rows.length} setParent=${setParent} dupGroups=${dupGroups} toDelete=${toDelete.length}`)
toDelete.slice(0, 30).forEach(d => console.log('  delete', d.id, 'from', d.key))
if (apply) for (const d of toDelete) await db.execute({ sql: `DELETE FROM "SkuSupplierDesign" WHERE id=?`, args: [d.id] })
console.log(apply ? 'APPLIED' : 'DRY-RUN (pass --apply to write)')
```

- [ ] **Step 2: Dry-run locally**

Run: `node scripts/migrate-design-parent.mjs`
Expected: prints counts; no writes.

- [ ] **Step 3: Commit (apply is run against prod separately, human-gated)**

```bash
git add scripts/migrate-design-parent.mjs
git commit -m "chore(design): migration to derive parentCode + merge duplicate library rows"
```
Do NOT run `--apply` on prod without an explicit go and a DB backup first.

---

## Self-Review

**Spec coverage:**
- Parent-code key + user-owned + suggestion → Tasks 1, 4 (pickParent), 8 (edit), 9 (backfill). ✓
- Match by contain/prefix, longest wins, supplier-scoped → Task 1. ✓
- designType NON_CUSTOM/CUSTOM/DUAL → Tasks 3, 4, 8. ✓
- Per-line custom detection (_print_files || previewCdnUrl) → Task 2, used in 5/6. ✓
- Order type NON/CUSTOM/DUAL/MIXED, non-sticky → Tasks 2 (reduce), 6 (persist every sync). ✓
- Task queue (ready=false auto-created + completable) → Tasks 4 (upsertTaskEntry), 6 (create), 8 (complete). ✓
- Matching full-SKU → parent → Tasks 4, 5, 6. ✓
- Migration auto-merge → Task 9; order type re-eval by sync → Task 6. ✓
- design-status DONE-with-link → Task 7. ✓

**Placeholder scan:** Logic tasks (1,2,4,5,7) carry full code + tests. Task 8 (UI) describes concrete columns/handlers against the existing page pattern rather than a full page dump — acceptable as it edits an existing file; no fabricated symbols. No TBD/TODO.

**Type consistency:** `ParentEntry` (design-parent) reused in repo (Task 4) and resolver (Task 5). `DesignLineInputV2 = DesignLineInput & { customized }` used in Tasks 5-6. `reduceOrderType`/`lineFamily`/`isLineCustomized` signatures identical across Tasks 2 and 6. `pickParent`, `loadReadyParentLookup`, `upsertTaskEntry` names consistent between Tasks 4 and 6.

## Open points carried to execution
- Exact order-type reduction for orders that mix NON_CUSTOM with exactly one other family is `MIXED` (per `reduceOrderType`); confirm this matches the desired UI during Task 6/8 review.
- `parentDesignType` in Task 6 re-runs `matchParentEntry` per line; fine at current volumes, revisit if sync gets slow.
