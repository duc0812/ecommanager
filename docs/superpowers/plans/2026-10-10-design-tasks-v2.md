# Design Tasks v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/design-studio` into the approved Design Tasks screen: a task queue (one task per order line needing a print file, key `LIT4545_1`) with lifecycle, assignment, KPI and deadlines, and the image-first workspace (template canvas / preview / mockup, personalization table, artwork slots, checklist, feed).

**Architecture:** New `DesignTask` + `DesignTaskEvent` tables are derived from `OrderLine` rows at sync time by `syncDesignTasks`; the v1 `updateLine` stays the only writer of `OrderLine.designDriveLink`, called by the DONE / reopen transitions. `PrintTemplate` is a data table (seeded) that the canvas draws from. `src/lib/design-tasks.ts` holds the pure guard `canTransition` plus the service functions; routes under `/api/design-studio/tasks*` are thin. The page is a port of the approved demo (`scratchpad/ws-demo/template.html`, also published as artifact 3LjFpgzo5NDZBCHeQsj58M) into React components under `src/app/design-studio/`.

**Tech Stack:** Next.js 14.2 app router (sync `{ params }`), Prisma v7 SQLite, Vitest on test.db, Tailwind tokens, Material Symbols.

**Spec:** `docs/superpowers/specs/2026-10-10-design-tasks-v2-design.md` (builds on `2026-10-09-design-studio-design.md`).

## Global Constraints

- Never add `url` to `datasource db {}`; after the schema change run `npx prisma migrate dev --name <name>`, `npx prisma generate`, bump `SCHEMA_VERSION` in `src/lib/db.ts` from `'v56'` to `'v57'`.
- `import { prisma } from '@/lib/db'`; types from `@/generated/prisma/client`.
- Tests on test.db create and delete their own rows; never touch dev.db.
- Every `/api/*` prefix needs an `API_ACCESS_RULES` entry; routes return `NextResponse.json(...)`; dynamic routes use `{ params }: { params: { key: string } }` (Next 14).
- Pages `'use client'`, render `<Sidebar />`, layout `<div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-[280px] flex-1 p-xl">…</main></div>`; Tailwind tokens only; icons `material-symbols-outlined`; dates `toLocaleDateString('en-US')`.
- No comments unless explaining a non-obvious constraint. Imports at top of file.
- Task key format: `<order number without '#'>_<linePosition>`. Statuses: `NEW ASSIGNED DOING REVIEW REJECTED ASK_CUSTOMER DONE CANCELLED`. Readiness: `AUTO LOW MANUAL` (v2 never produces `AUTO`).
- Leader = role `SUPERADMIN` or `ADMIN`; Designer = any other role holding `design_tasks`.
- Commit after every task; messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A re-sync must not duplicate or reset tasks: `syncDesignTasks` is idempotent and keeps status/assignee — pinned in Task 2.
2. DONE must go through `updateLine(done:true)` so the order leaves PENDING_DESIGN exactly as v1 — pinned in Task 3.
3. A Designer must not be able to approve a non-AUTO task or assign; a Leader can — pinned by the `canTransition` matrix in Task 2 and the route test in Task 4.
4. `ASK_CUSTOMER` → continue must restore the previous status, not drop to NEW — pinned in Task 3.
5. An upload of a PNG/JPG must record `widthPx/heightPx` so the "Yêu cầu xưởng" table works; a PSD/PDF records null and must not fail — pinned in Task 4.

---

### Task 1: Schema, permission, settings, template seed

**Files:**
- Modify: `prisma/schema.prisma` (after `DesignArtwork`; `DesignArtwork` gains two columns; `Order` and `Supplier` gain relations)
- Modify: `src/lib/db.ts:7`
- Modify: `src/lib/roles.ts` (FeaturePermission union, FEATURE_LABELS, FEATURE_GROUPS Fulfillment list, DEFAULT_ROLE_PERMISSIONS ADMIN + SUPPORT, FEATURE_PATHS)
- Modify: `src/lib/api-access.ts:30`
- Create: `src/lib/design-settings.ts`
- Create: `scripts/seed-print-template-merchize.mjs`
- Test: `tests/design-settings.integration.test.ts`

**Interfaces:**
- Produces: models `DesignTask`, `DesignTaskEvent`, `PrintTemplate`; `DesignArtwork.widthPx Int?`, `heightPx Int?`; permission `design_tasks`; `getDesignSettings(): Promise<DesignSettings>`, `saveDesignSettings(s: DesignSettings)`, `DEFAULT_DESIGN_SETTINGS`, type `DesignSettings = { slaCustomHours: number; slaNonCustomHours: number; kpiByType: Record<string, number>; rejectReasons: string[] }`, `kpiForProductType(settings, productType: string | null): number`.

- [ ] **Step 1: Schema**

Append after `model DesignArtwork { … }`:

```prisma
model DesignTask {
  id               String            @id @default(cuid())
  orderId          String
  order            Order             @relation(fields: [orderId], references: [id], onDelete: Cascade)
  shopifyLineId    String
  taskKey          String
  status           String            @default("NEW")
  readiness        String            @default("MANUAL")
  assigneeId       String?
  kpi              Float             @default(0.3)
  dueAt            DateTime?
  slaHours         Int               @default(24)
  rejectReasons    String?
  rejectNote       String?
  prevStatus       String?
  supplierSnapshot String?
  createdAt        DateTime          @default(now())
  updatedAt        DateTime          @updatedAt
  events           DesignTaskEvent[]
  @@unique([orderId, shopifyLineId])
  @@unique([taskKey])
  @@index([status])
  @@index([assigneeId])
}

model DesignTaskEvent {
  id        String     @id @default(cuid())
  taskId    String
  task      DesignTask @relation(fields: [taskId], references: [id], onDelete: Cascade)
  type      String
  message   String
  actorId   String?
  createdAt DateTime   @default(now())
  @@index([taskId])
}

model PrintTemplate {
  id             String   @id @default(cuid())
  supplierId     String
  supplier       Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  supplierSku    String?
  name           String
  widthPx        Int
  heightPx       Int
  dpi            Int      @default(300)
  bleedIn        Float    @default(0.125)
  safeIn         Float    @default(0.2)
  mirror         Boolean  @default(false)
  areas          String
  guideImagePath String?
  templateUrl    String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([supplierId, supplierSku])
}
```

In `model DesignArtwork` add `widthPx Int?` and `heightPx Int?` after `mimeType`. In `model Order` add `designTasks DesignTask[]`. In `model Supplier` add `printTemplates PrintTemplate[]`.

- [ ] **Step 2: Migrate, generate, bump**

```bash
npx prisma migrate dev --name design_tasks_v2
npx prisma generate
```
Set `SCHEMA_VERSION = 'v57'`.

- [ ] **Step 3: Permission and access rule**

`src/lib/roles.ts`: add `| 'design_tasks'` to the union after `'fulfillment_design_library'`; `FEATURE_LABELS.design_tasks = 'Design Tasks'`; in `FEATURE_GROUPS` Fulfillment permissions insert `'design_tasks'` after `'fulfillment_design_library'`; add `'design_tasks'` to `DEFAULT_ROLE_PERMISSIONS.ADMIN` and `.SUPPORT`; in `FEATURE_PATHS` change `fulfillment_design_library: ['/fulfillment/design-library', '/design-studio']` back to `['/fulfillment/design-library']` and add `design_tasks: ['/design-studio']`. Check the ordered list near line 186 (if it enumerates permissions explicitly) and add the key there too.

`src/lib/api-access.ts` line 30: `{ prefix: '/api/design-studio', access: ['design_tasks', 'fulfillment_design_library', 'fulfillment_orders'] },`

- [ ] **Step 4: Write the failing settings test**

`tests/design-settings.integration.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { getDesignSettings, saveDesignSettings, DEFAULT_DESIGN_SETTINGS, kpiForProductType } from '@/lib/design-settings'

afterAll(async () => { await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } }) })

describe('design settings', () => {
  it('returns defaults when nothing is stored', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
    expect(await getDesignSettings()).toEqual(DEFAULT_DESIGN_SETTINGS)
  })
  it('round-trips and merges missing keys', async () => {
    await saveDesignSettings({ ...DEFAULT_DESIGN_SETTINGS, slaCustomHours: 12 })
    const s = await getDesignSettings()
    expect(s.slaCustomHours).toBe(12)
    expect(s.rejectReasons).toEqual(DEFAULT_DESIGN_SETTINGS.rejectReasons)
  })
  it('kpiForProductType matches by substring, else default', () => {
    expect(kpiForProductType(DEFAULT_DESIGN_SETTINGS, 'Baseball Jersey')).toBe(0.3)
    expect(kpiForProductType(DEFAULT_DESIGN_SETTINGS, 'Crew Socks')).toBe(0.4)
    expect(kpiForProductType(DEFAULT_DESIGN_SETTINGS, null)).toBe(DEFAULT_DESIGN_SETTINGS.kpiByType.default)
  })
})
```

- [ ] **Step 5: Run it — expect FAIL (module missing)**

`npx vitest run tests/design-settings.integration.test.ts`

- [ ] **Step 6: Implement settings**

`src/lib/design-settings.ts`:

```ts
import { prisma } from '@/lib/db'

export type DesignSettings = {
  slaCustomHours: number
  slaNonCustomHours: number
  kpiByType: Record<string, number>
  rejectReasons: string[]
}

export const DEFAULT_DESIGN_SETTINGS: DesignSettings = {
  slaCustomHours: 24,
  slaNonCustomHours: 48,
  kpiByType: { jersey: 0.3, shirt: 0.3, hoodie: 0.4, socks: 0.4, ornament: 0.2, tumbler: 0.15, mug: 0.15, default: 0.3 },
  rejectReasons: ['Sai chính tả / nội dung', 'Lệch tâm / ra ngoài vùng an toàn', 'Thiếu nét', 'Sai màu / biến thể', 'Thiếu bleed', 'Font sai'],
}

const KEY = 'design.settings'

export async function getDesignSettings(): Promise<DesignSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
  if (!row) return DEFAULT_DESIGN_SETTINGS
  try {
    const parsed = JSON.parse(row.value)
    return {
      ...DEFAULT_DESIGN_SETTINGS,
      ...parsed,
      kpiByType: { ...DEFAULT_DESIGN_SETTINGS.kpiByType, ...(parsed.kpiByType ?? {}) },
      rejectReasons: Array.isArray(parsed.rejectReasons) && parsed.rejectReasons.length ? parsed.rejectReasons : DEFAULT_DESIGN_SETTINGS.rejectReasons,
    }
  } catch { return DEFAULT_DESIGN_SETTINGS }
}

export async function saveDesignSettings(s: DesignSettings) {
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } })
}

export function kpiForProductType(s: DesignSettings, productType: string | null): number {
  const t = (productType ?? '').toLowerCase()
  for (const [k, v] of Object.entries(s.kpiByType)) if (k !== 'default' && t.includes(k)) return v
  return s.kpiByType.default ?? 0.3
}
```

- [ ] **Step 7: Run — expect PASS**

- [ ] **Step 8: Seed script**

`scripts/seed-print-template-merchize.mjs` (run with `node scripts/seed-print-template-merchize.mjs`; the repo's `scripts/*.mjs` use `@libsql/client` raw SQL against `DATABASE_URL` or `./dev.db` — copy the header of `scripts/migrate-design-parent.mjs` and write the upsert as `INSERT … ON CONFLICT(supplierId, supplierSku) DO UPDATE`, generating the id with `crypto.randomUUID()`; the Prisma-flavoured snippet below shows the intended rows):

```js
const AREAS = [
  { name: 'Front L', x: 220, y: 380, w: 2350, h: 5100 },
  { name: 'Front R', x: 2700, y: 380, w: 2350, h: 5100 },
  { name: 'Back', x: 5250, y: 380, w: 3900, h: 5100 },
  { name: 'Sleeve L', x: 9350, y: 520, w: 1300, h: 2000 },
  { name: 'Sleeve R', x: 10800, y: 520, w: 1300, h: 2000 },
  { name: 'Collar', x: 9350, y: 2900, w: 2750, h: 700 },
]
const supplier = await prisma.supplier.findFirst({ where: { OR: [{ code: 'MERCHIZE' }, { name: { contains: 'Merchize' } }] } })
if (!supplier) { console.log('No Merchize supplier in this DB — nothing seeded'); process.exit(0) }
await prisma.printTemplate.upsert({
  where: { supplierId_supplierSku: { supplierId: supplier.id, supplierSku: 'BAJE' } },
  create: { supplierId: supplier.id, supplierSku: 'BAJE', name: 'BAJE AOP Baseball Jersey', widthPx: 12289, heightPx: 5906, dpi: 150, bleedIn: 0.125, safeIn: 0.2, areas: JSON.stringify(AREAS), templateUrl: 'https://drive.google.com/drive/folders/18r2D9XofR5LOLIlQKsce-xzNxweLgOF8' },
  update: { widthPx: 12289, heightPx: 5906, dpi: 150, areas: JSON.stringify(AREAS) },
})
console.log('seeded BAJE for', supplier.name)
```

Note in the script header: the area coordinates are the demo's illustrative layout until the PSD is measured.

- [ ] **Step 9: Full checks and commit**

`npx vitest run && npx tsc --noEmit -p .`

```bash
git add prisma src/lib/db.ts src/lib/roles.ts src/lib/api-access.ts src/lib/design-settings.ts scripts/seed-print-template-merchize.mjs tests/design-settings.integration.test.ts
git commit -m "feat(design-tasks): schema, design_tasks permission, settings, Merchize template seed"
```

---

### Task 2: Task keys, transition guard, task sync

**Files:**
- Create: `src/lib/design-tasks.ts`
- Modify: `src/app/api/shopify/orders/sync/route.ts` (inside `for (const o of page.orders)`, right before `totalSynced++` ~line 487)
- Test: `tests/design-tasks.test.ts`, `tests/design-tasks-sync.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export type TaskStatus = 'NEW'|'ASSIGNED'|'DOING'|'REVIEW'|'REJECTED'|'ASK_CUSTOMER'|'DONE'|'CANCELLED'
export type Readiness = 'AUTO'|'LOW'|'MANUAL'
export type ActorRole = 'LEADER'|'DESIGNER'
export function taskKeyFor(orderNumber: string, linePosition: number): string      // '#LIT4545',1 → 'LIT4545_1'
export function isLeader(role: string): boolean                                     // SUPERADMIN|ADMIN
export function canTransition(from: TaskStatus, to: TaskStatus, actor: ActorRole, readiness: Readiness): boolean
export async function syncDesignTasks(orderId: string): Promise<{ created: number; cancelled: number; completed: number }>
```

- [ ] **Step 1: Failing unit tests**

`tests/design-tasks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { taskKeyFor, canTransition } from '@/lib/design-tasks'

describe('taskKeyFor', () => {
  it('strips # and joins with _', () => {
    expect(taskKeyFor('#LIT4545', 1)).toBe('LIT4545_1')
    expect(taskKeyFor('RMS1187', 2)).toBe('RMS1187_2')
  })
})

describe('canTransition', () => {
  const T = (f: any, t: any, a: any, r: any = 'LOW') => canTransition(f, t, a, r)
  it('leader assigns, designer takes', () => {
    expect(T('NEW', 'ASSIGNED', 'LEADER')).toBe(true)
    expect(T('NEW', 'ASSIGNED', 'DESIGNER')).toBe(false)
    expect(T('NEW', 'DOING', 'DESIGNER')).toBe(true)
    expect(T('ASSIGNED', 'DOING', 'DESIGNER')).toBe(true)
    expect(T('ASSIGNED', 'NEW', 'DESIGNER')).toBe(true)
  })
  it('review flow', () => {
    expect(T('DOING', 'REVIEW', 'DESIGNER')).toBe(true)
    expect(T('REJECTED', 'REVIEW', 'DESIGNER')).toBe(true)
    expect(T('REVIEW', 'DONE', 'LEADER')).toBe(true)
    expect(T('REVIEW', 'DONE', 'DESIGNER')).toBe(false)
    expect(T('REVIEW', 'DONE', 'DESIGNER', 'AUTO')).toBe(true)
    expect(T('NEW', 'DONE', 'DESIGNER', 'AUTO')).toBe(true)
    expect(T('REVIEW', 'REJECTED', 'LEADER')).toBe(true)
    expect(T('REVIEW', 'REJECTED', 'DESIGNER')).toBe(false)
  })
  it('ask customer from any open status, continue handled by service', () => {
    for (const s of ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']) expect(T(s, 'ASK_CUSTOMER', 'DESIGNER')).toBe(true)
    expect(T('DONE', 'ASK_CUSTOMER', 'DESIGNER')).toBe(false)
  })
  it('reopen and forbidden moves', () => {
    expect(T('DONE', 'DOING', 'DESIGNER')).toBe(true)
    expect(T('CANCELLED', 'DOING', 'LEADER')).toBe(false)
    expect(T('NEW', 'REVIEW', 'DESIGNER')).toBe(false)
  })
})
```

- [ ] **Step 2: Run — FAIL (module missing)**

- [ ] **Step 3: Implement the pure parts**

`src/lib/design-tasks.ts` (first half):

```ts
import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { parseAttributes, sourcePrintFiles } from '@/lib/design-studio'
import { getDesignSettings, kpiForProductType } from '@/lib/design-settings'

export type TaskStatus = 'NEW' | 'ASSIGNED' | 'DOING' | 'REVIEW' | 'REJECTED' | 'ASK_CUSTOMER' | 'DONE' | 'CANCELLED'
export type Readiness = 'AUTO' | 'LOW' | 'MANUAL'
export type ActorRole = 'LEADER' | 'DESIGNER'
export const TASK_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED', 'ASK_CUSTOMER', 'DONE', 'CANCELLED']
const OPEN: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']

export function taskKeyFor(orderNumber: string, linePosition: number): string {
  return `${orderNumber.replace(/^#/, '')}_${linePosition}`
}

export function isLeader(role: string): boolean {
  return role === 'SUPERADMIN' || role === 'ADMIN'
}

export function canTransition(from: TaskStatus, to: TaskStatus, actor: ActorRole, readiness: Readiness): boolean {
  if (from === to) return false
  if (from === 'CANCELLED') return false
  if (to === 'ASK_CUSTOMER') return OPEN.includes(from)
  if (to === 'CANCELLED') return actor === 'LEADER'
  switch (to) {
    case 'ASSIGNED': return actor === 'LEADER' && (from === 'NEW' || from === 'DOING' || from === 'REJECTED')
    case 'NEW': return from === 'ASSIGNED'
    case 'DOING': return from === 'NEW' || from === 'ASSIGNED' || from === 'DONE' || from === 'REJECTED'
    case 'REVIEW': return from === 'DOING' || from === 'REJECTED'
    case 'DONE': return actor === 'LEADER' ? from === 'REVIEW' : (readiness === 'AUTO' && (from === 'NEW' || from === 'ASSIGNED' || from === 'DOING' || from === 'REVIEW'))
    case 'REJECTED': return actor === 'LEADER' && from === 'REVIEW'
    default: return false
  }
}

function readinessFor(customAttributesJson: string | null): Readiness {
  return sourcePrintFiles(parseAttributes(customAttributesJson)).length > 0 ? 'LOW' : 'MANUAL'
}
```

- [ ] **Step 4: Run unit tests — PASS**

- [ ] **Step 5: Failing sync integration test**

`tests/design-tasks-sync.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { syncDesignTasks } from '@/lib/design-tasks'

const ORDER_ID = 'gid://test/Order/dt-sync-1'
const SHOP = 'dt-sync.myshopify.com'
const SUP = 'sup_dt_sync'

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_dt_sync' }, create: { id: 'proj_dt_sync', name: 'DT sync', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dt_sync' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DTSYNC' }, create: { id: SUP, name: 'DT Sync Supplier', code: 'DTSYNC' }, update: {} })
  await prisma.order.create({ data: {
    id: ORDER_ID, projectId: 'proj_dt_sync', storeId, shopifyOrderNumber: '#DTS1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'), pipelineStatus: 'PENDING_DESIGN', orderType: 'MIXED',
    lines: { create: [
      { shopifyLineId: 's1', sku: 'A', productTitle: 'Jersey', shopifyProductType: 'Baseball Jersey', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP, customized: true,
        customAttributesJson: JSON.stringify([{ key: 'Name', value: 'X' }, { key: '_print_files', value: JSON.stringify([{ print_area: 'PRINT', url: 'https://cdn.example/p.png' }]) }]) },
      { shopifyLineId: 's2', sku: 'B', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 1, resolvedSupplierId: SUP, designDriveLink: 'https://drive.example/lib' },
      { shopifyLineId: 's3', sku: 'C', productTitle: 'Socks', qty: 1, linePosition: 3, unitPrice: 1, resolvedSupplierId: null, customized: true },
      { shopifyLineId: 's4', sku: null, productTitle: 'Tip', qty: 1, linePosition: 4, unitPrice: 1 },
    ] } } })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
})

describe('syncDesignTasks', () => {
  it('creates one NEW task per mapped product line without a design link', async () => {
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.created).toBe(1)
    const tasks = await prisma.designTask.findMany({ where: { orderId: ORDER_ID } })
    expect(tasks.map(t => t.taskKey)).toEqual(['DTS1_1'])
    expect(tasks[0].status).toBe('NEW')
    expect(tasks[0].readiness).toBe('LOW')
    expect(tasks[0].kpi).toBe(0.3)
    expect(tasks[0].slaHours).toBe(24)
  })
  it('is idempotent and keeps status and assignee', async () => {
    await prisma.designTask.update({ where: { taskKey: 'DTS1_1' }, data: { status: 'DOING', assigneeId: 'u1' } })
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.created).toBe(0)
    const t = await prisma.designTask.findUnique({ where: { taskKey: 'DTS1_1' } })
    expect(t?.status).toBe('DOING'); expect(t?.assigneeId).toBe('u1')
  })
  it('completes a task when the line gained a design link elsewhere', async () => {
    await prisma.orderLine.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 's1' }, data: { designDriveLink: 'https://drive.example/x' } })
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.completed).toBe(1)
    const t = await prisma.designTask.findUnique({ where: { taskKey: 'DTS1_1' }, include: { events: true } })
    expect(t?.status).toBe('DONE')
    expect(t?.events.some(e => e.type === 'SYSTEM' && /outside/i.test(e.message))).toBe(true)
  })
  it('cancels tasks of a cancelled order', async () => {
    await prisma.orderLine.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 's1' }, data: { designDriveLink: null } })
    await prisma.designTask.update({ where: { taskKey: 'DTS1_1' }, data: { status: 'DOING' } })
    await prisma.order.update({ where: { id: ORDER_ID }, data: { pipelineStatus: 'CANCELLED' } })
    const r = await syncDesignTasks(ORDER_ID)
    expect(r.cancelled).toBe(1)
    expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTS1_1' } }))?.status).toBe('CANCELLED')
  })
})
```

- [ ] **Step 6: Run — FAIL (`syncDesignTasks` missing)**

- [ ] **Step 7: Implement `syncDesignTasks`**

Append to `src/lib/design-tasks.ts`:

```ts
export async function syncDesignTasks(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: true, designTasks: true } })
  if (!order) return { created: 0, cancelled: 0, completed: 0 }
  const settings = await getDesignSettings()
  const supplierIds = Array.from(new Set(order.lines.map(l => l.resolvedSupplierId).filter(Boolean) as string[]))
  const suppliers = supplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : []
  const supplierName = new Map(suppliers.map(s => [s.id, s.name]))
  const orderClosed = ['CANCELLED', 'REFUNDED'].includes(order.pipelineStatus)
  let created = 0, cancelled = 0, completed = 0

  for (const line of order.lines) {
    if (isNonProductLine(line) || !line.resolvedSupplierId) continue
    const existing = order.designTasks.find(t => t.shopifyLineId === line.shopifyLineId)
    if (orderClosed) {
      if (existing && existing.status !== 'CANCELLED' && existing.status !== 'DONE') {
        await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'CANCELLED', events: { create: { type: 'SYSTEM', message: 'Đơn huỷ — task tự huỷ' } } } })
        cancelled++
      }
      continue
    }
    if (line.designDriveLink) {
      if (existing && existing.status !== 'DONE' && existing.status !== 'CANCELLED') {
        await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'DONE', events: { create: { type: 'SYSTEM', message: 'Design có từ ngoài studio (Trello / Library) — task done outside' } } } })
        completed++
      }
      continue
    }
    if (existing) continue
    const slaHours = line.customized ? settings.slaCustomHours : settings.slaNonCustomHours
    await prisma.designTask.create({ data: {
      orderId, shopifyLineId: line.shopifyLineId, taskKey: taskKeyFor(order.shopifyOrderNumber, line.linePosition),
      status: 'NEW', readiness: readinessFor(line.customAttributesJson), kpi: kpiForProductType(settings, line.shopifyProductType),
      slaHours, dueAt: new Date(order.placedAt.getTime() + slaHours * 3600_000), supplierSnapshot: supplierName.get(line.resolvedSupplierId) ?? null,
      events: { create: { type: 'SYSTEM', message: 'Đơn vào từ Shopify — tạo task' } },
    } })
    created++
  }
  return { created, cancelled, completed }
}
```

- [ ] **Step 8: Run — PASS**

- [ ] **Step 9: Hook into the sync route**

In `src/app/api/shopify/orders/sync/route.ts`, import `syncDesignTasks` from `@/lib/design-tasks`, and right before `totalSynced++` add:

```ts
      try { await syncDesignTasks(o.id) } catch (e: any) { errors.push(`design tasks ${o.name}: ${e.message}`) }
```

- [ ] **Step 10: Full checks and commit**

`npx vitest run && npx tsc --noEmit -p .`

```bash
git add src/lib/design-tasks.ts src/app/api/shopify/orders/sync/route.ts tests/design-tasks.test.ts tests/design-tasks-sync.integration.test.ts
git commit -m "feat(design-tasks): task keys, transition guard, task sync from orders"
```

---

### Task 3: Transition service, list and load

**Files:**
- Modify: `src/lib/design-tasks.ts`
- Test: `tests/design-tasks-transition.integration.test.ts`

**Interfaces:**
- Consumes: `updateLine(lineId, { done })` from `@/lib/design-studio`; `loadWorkspace(orderId)`.
- Produces:

```ts
export type Actor = { id: string; name: string; role: string }
export type TransitionInput = { to: TaskStatus; note?: string; reasons?: string[]; assigneeId?: string; kpi?: number; dueHours?: number; continue?: boolean }
export async function transitionTask(taskKey: string, actor: Actor, input: TransitionInput): Promise<{ task: TaskRow; order: { id: string; designReady: boolean; pipelineStatus: string } | null }>
export async function addTaskNote(taskKey: string, actor: Actor, message: string): Promise<void>
export type TaskRow = { id: string; taskKey: string; status: TaskStatus; readiness: Readiness; assigneeId: string | null; assigneeName: string | null; kpi: number; dueAt: string | null; slaHours: number; rejectReasons: string[]; rejectNote: string | null; orderId: string; orderNumber: string; placedAt: string; shopifyLineId: string; linePosition: number; sku: string | null; productTitle: string; variantTitle: string | null; previewUrl: string | null; supplierName: string | null; customized: boolean; storeName: string }
export async function listTasks(f: { statuses?: TaskStatus[]; readiness?: Readiness; assigneeId?: string; q?: string; limit?: number }): Promise<TaskRow[]>
export type TaskDetail = { task: TaskRow; line: WorkspaceLine; order: Workspace['order']; template: TemplateRow | null; events: { id: string; type: string; message: string; actorName: string | null; createdAt: string }[]; assignable: { id: string; name: string }[]; settings: DesignSettings; prevStatus: TaskStatus | null }
export type TemplateRow = { id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean; areas: { name: string; x: number; y: number; w: number; h: number }[]; guideImageUrl: string | null; templateUrl: string | null }
export async function loadTask(taskKey: string): Promise<TaskDetail | null>
export async function templateForLine(line: { resolvedSupplierId: string | null; resolvedSupplierSku: string | null }): Promise<TemplateRow | null>
```

- [ ] **Step 1: Failing test**

`tests/design-tasks-transition.integration.test.ts` — fixture: project/store/supplier (code `DTTR`), order `#DTT1` PENDING_DESIGN with one mapped customized line `t1` (attributes with `_print_files`) and a Tip line; one `DesignArtwork` row for `(orderId,'t1','PRINT')` (storagePath `x/a.png`, 1 byte); `AppUser` rows `lead` (role ADMIN) and `des` (role SUPPORT) upserted by email `lead@dt.test` / `des@dt.test`. Run `syncDesignTasks` in `beforeAll`. Cases:

```ts
const LEAD = { id: leadId, name: 'Lead', role: 'ADMIN' }, DES = { id: desId, name: 'Des', role: 'SUPPORT' }
it('designer cannot assign; leader can and dueAt/kpi are set', async () => {
  await expect(transitionTask('DTT1_1', DES, { to: 'ASSIGNED', assigneeId: desId })).rejects.toThrow(/không được phép|not allowed/i)
  const r = await transitionTask('DTT1_1', LEAD, { to: 'ASSIGNED', assigneeId: desId, kpi: 0.5, dueHours: 10, note: 'dùng master' })
  expect(r.task.status).toBe('ASSIGNED'); expect(r.task.assigneeId).toBe(desId); expect(r.task.kpi).toBe(0.5)
  expect(new Date(r.task.dueAt!).getTime()).toBeGreaterThan(Date.now() + 9 * 3600_000)
})
it('designer takes, submits for review; review requires artwork', async () => {
  expect((await transitionTask('DTT1_1', DES, { to: 'DOING' })).task.status).toBe('DOING')
  expect((await transitionTask('DTT1_1', DES, { to: 'REVIEW' })).task.status).toBe('REVIEW')
})
it('leader rejects with reasons, designer resubmits', async () => {
  const r = await transitionTask('DTT1_1', LEAD, { to: 'REJECTED', reasons: ['Thiếu nét'], note: 'vỡ' })
  expect(r.task.rejectReasons).toEqual(['Thiếu nét'])
  expect((await transitionTask('DTT1_1', DES, { to: 'REVIEW' })).task.status).toBe('REVIEW')
})
it('ask customer then continue restores REVIEW', async () => {
  expect((await transitionTask('DTT1_1', DES, { to: 'ASK_CUSTOMER', note: 'font?' })).task.status).toBe('ASK_CUSTOMER')
  const r = await transitionTask('DTT1_1', DES, { to: 'REVIEW', continue: true })
  expect(r.task.status).toBe('REVIEW')
})
it('leader approves → line done, order leaves PENDING_DESIGN', async () => {
  const r = await transitionTask('DTT1_1', LEAD, { to: 'DONE' })
  expect(r.task.status).toBe('DONE'); expect(r.order?.designReady).toBe(true); expect(r.order?.pipelineStatus).not.toBe('PENDING_DESIGN')
  const line = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID, shopifyLineId: 't1' } })
  expect(line?.designDriveLink).toMatch(/^\/api\/design-studio\/file\//)
})
it('reopen clears the link', async () => {
  const r = await transitionTask('DTT1_1', DES, { to: 'DOING' })
  expect(r.task.status).toBe('DOING'); expect(r.order?.designReady).toBe(false)
})
it('listTasks filters by status and assignee; loadTask returns the line and events', async () => {
  const mine = await listTasks({ assigneeId: desId }); expect(mine.map(t => t.taskKey)).toContain('DTT1_1')
  expect((await listTasks({ statuses: ['DONE'] })).some(t => t.taskKey === 'DTT1_1')).toBe(false)
  const d = await loadTask('DTT1_1'); expect(d?.line.shopifyLineId ?? d?.task.shopifyLineId).toBe('t1'); expect(d!.events.length).toBeGreaterThan(3)
  expect(await loadTask('NOPE_1')).toBeNull()
})
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Append to `src/lib/design-tasks.ts` (add `import { updateLine, loadWorkspace, type WorkspaceLine, type Workspace } from '@/lib/design-studio'` and `import type { DesignSettings } from '@/lib/design-settings'` at the top):

```ts
export type Actor = { id: string; name: string; role: string }
export type TransitionInput = { to: TaskStatus; note?: string; reasons?: string[]; assigneeId?: string; kpi?: number; dueHours?: number; continue?: boolean }

function actorRole(a: Actor): ActorRole { return isLeader(a.role) ? 'LEADER' : 'DESIGNER' }

export async function transitionTask(taskKey: string, actor: Actor, input: TransitionInput) {
  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) throw new Error('Task not found')
  const from = task.status as TaskStatus
  const role = actorRole(actor)
  if (!(input.continue && from === 'ASK_CUSTOMER' && input.to === (task.prevStatus ?? 'NEW')) && !canTransition(from, input.to, role, task.readiness as Readiness)) {
    throw new Error(`Chuyển ${from} → ${input.to} không được phép với vai trò ${role}`)
  }
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId } })
  if (!line) throw new Error('Line not found')

  const data: any = { status: input.to }
  const events: { type: string; message: string; actorId: string }[] = []
  const say = (type: string, message: string) => events.push({ type, message, actorId: actor.id })

  if (input.to === 'ASSIGNED') {
    if (!input.assigneeId) throw new Error('assigneeId is required')
    data.assigneeId = input.assigneeId
    if (input.kpi !== undefined) data.kpi = input.kpi
    if (input.dueHours !== undefined) data.dueAt = new Date(Date.now() + input.dueHours * 3600_000)
    const who = await prisma.appUser.findUnique({ where: { id: input.assigneeId }, select: { name: true } })
    say('ASSIGN', `Giao cho ${who?.name ?? input.assigneeId} · ${data.kpi ?? task.kpi} điểm${input.dueHours ? ` · hạn ${input.dueHours}h` : ''}${input.note ? ` · ${input.note}` : ''}`)
  } else if (input.to === 'NEW') {
    data.assigneeId = null; say('STATUS', 'Từ chối việc — trả về leader giao lại')
  } else if (input.to === 'DOING') {
    if (!task.assigneeId) data.assigneeId = actor.id
    if (!task.dueAt) data.dueAt = new Date(Date.now() + task.slaHours * 3600_000)
    say('STATUS', from === 'DONE' ? 'Mở lại để sửa' : 'Nhận việc')
  } else if (input.to === 'REVIEW') {
    say('STATUS', from === 'ASK_CUSTOMER' ? 'Tiếp tục sau khi hỏi khách' : 'Gửi duyệt')
  } else if (input.to === 'REJECTED') {
    data.rejectReasons = JSON.stringify(input.reasons ?? []); data.rejectNote = input.note ?? null
    say('REJECT', `Trả lại sửa: ${(input.reasons ?? []).join(', ')}${input.note ? ` — ${input.note}` : ''}`)
  } else if (input.to === 'ASK_CUSTOMER') {
    data.prevStatus = from; say('ASK', `Hỏi khách: ${input.note ?? ''}`.trim())
  } else if (input.to === 'DONE') {
    say('STATUS', role === 'LEADER' ? 'Duyệt & gửi xưởng' : 'Duyệt nhanh (file tự động) & gửi xưởng')
  } else if (input.to === 'CANCELLED') {
    say('STATUS', 'Huỷ task')
  }
  if (input.continue) data.prevStatus = null
  if (input.note && !['ASSIGNED', 'REJECTED', 'ASK_CUSTOMER'].includes(input.to)) say('NOTE', input.note)

  let order: { id: string; designReady: boolean; pipelineStatus: string } | null = null
  if (input.to === 'DONE') order = (await updateLine(line.id, { done: true }))?.order ?? null
  if (from === 'DONE' && input.to === 'DOING') order = (await updateLine(line.id, { done: false }))?.order ?? null

  const updated = await prisma.designTask.update({ where: { id: task.id }, data: { ...data, events: { create: events } } })
  return { task: await rowFor(updated.taskKey), order }
}

export async function addTaskNote(taskKey: string, actor: Actor, message: string) {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true } })
  if (!task) throw new Error('Task not found')
  await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'NOTE', message, actorId: actor.id } })
}
```

Then `rowFor`, `listTasks`, `loadTask`, `templateForLine`: `listTasks` queries `designTask` with `include: { order: { include: { store: { include: { project: true } }, lines: true } } }` filtered by statuses / readiness / assigneeId, applies `q` in memory against taskKey, sku, productTitle and personalization values (parse `customAttributesJson` with `visibleCustomAttributes`), joins user names in one `appUser.findMany`, maps to `TaskRow` (previewUrl = line.previewCdnUrl, supplierName = supplierSnapshot), sorted by `dueAt` ascending (nulls last), `limit` default 300. `rowFor(taskKey)` = `listTasks` for one key. `loadTask` = task row + `loadWorkspace(orderId)` picking the line by `shopifyLineId` + `templateForLine(line)` + events (with actor names) + assignable users (`appUser.findMany({ where: { status: 'ACTIVE' }, select: { id, name, role } })` filtered to ADMIN/SUPPORT/SELLER) + `getDesignSettings()` + `prevStatus`. `templateForLine` = `printTemplate.findFirst({ where: { supplierId, OR: [{ supplierSku }, { supplierSku: null }] }, orderBy: { supplierSku: 'desc' } })` (exact SKU wins; also try matching `supplierSku` as a prefix of the line's supplier SKU: load all templates of the supplier and pick the longest `supplierSku` that the line's SKU starts with), mapping `areas` JSON and `guideImageUrl = guideImagePath ? '/api/design-studio/file/guide/' + id : null` (serving the guide image is Task 4).

- [ ] **Step 4: Run — PASS**; then `npx vitest run && npx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

```bash
git add src/lib/design-tasks.ts tests/design-tasks-transition.integration.test.ts
git commit -m "feat(design-tasks): transition service, task list and detail loaders"
```

---

### Task 4: API routes and image-size probe

**Files:**
- Create: `src/app/api/design-studio/tasks/route.ts`, `tasks/[key]/route.ts`, `tasks/[key]/transition/route.ts`, `tasks/[key]/events/route.ts`, `tasks/sync/route.ts`, `templates/route.ts`, `settings/route.ts`, `file/guide/[templateId]/route.ts`
- Modify: `src/lib/design-storage.ts` (probe), `src/app/api/design-studio/lines/[lineId]/artwork/route.ts` (no change needed if probe is inside `saveArtwork`)
- Test: `tests/design-tasks-routes.integration.test.ts`, `tests/image-size.test.ts`

**Interfaces:**
- `GET /api/design-studio/tasks?statuses=NEW,DOING&readiness=LOW&mine=1&q=` → `{ tasks: TaskRow[], me: { id, name, role, isLeader } }` (`mine=1` uses the auth user's id).
- `GET /api/design-studio/tasks/[key]` → `TaskDetail & { me }`; 404.
- `POST /api/design-studio/tasks/[key]/transition` body `TransitionInput` → `{ task, order }`; 400 with the guard message; 401 without a user.
- `POST /api/design-studio/tasks/[key]/events` `{ message }` → `{ ok: true }`.
- `POST /api/design-studio/tasks/sync` `{ orderId? }` → `{ created, cancelled, completed, orders }` (all orders in PENDING_DESIGN/DESIGN_REJECTED when no id).
- `GET /api/design-studio/templates?supplierId=` → `{ templates }`; `POST` upsert by `(supplierId, supplierSku)` (leader only via `requireAdmin`).
- `GET /api/design-studio/settings` → `DesignSettings`; `PUT` (`requireSuperadmin`).
- `GET /api/design-studio/file/guide/[templateId]` streams `guideImagePath` from the storage root (same containment check as `readArtwork`).
- `export function imageSize(bytes: Buffer): { width: number; height: number } | null` in `src/lib/image-size.ts` — PNG (IHDR) and JPEG (SOF0/SOF2 markers) only; `saveArtwork` stores the result in `widthPx/heightPx` and returns them on `ArtworkRow` (add `widthPx: number | null; heightPx: number | null` to the type in `design-studio.ts` and to `loadWorkspace`'s mapping).

- [ ] **Step 1: Failing tests**

`tests/image-size.test.ts`: build a 1-pixel PNG header buffer (`89 50 4E 47 0D 0A 1A 0A` + IHDR chunk with width 640 height 480) → `{640,480}`; a JPEG buffer `FF D8 FF E0 … FF C0 00 11 08 01 E0 02 80` → `{640,480}` (height 0x01E0, width 0x0280); random bytes → null.

`tests/design-tasks-routes.integration.test.ts`: fixture like Task 3; call the exported handlers with `new NextRequest('http://x/api/design-studio/tasks?statuses=NEW')` after stubbing auth: the routes read the user via `getAuthUser(req)` — in tests, sign a real cookie using `signToken` from `@/lib/auth` for a fixture `AppUser` (read `src/lib/auth.ts` for the helper name and `AUTH_COOKIE`) and set it with `req.cookies.set(AUTH_COOKIE, token)`. Assert: list returns the fixture task; transition as the SUPPORT user to `ASSIGNED` → 400; as ADMIN → 200; `POST events` adds a NOTE visible in `GET /tasks/[key]`; `POST tasks/sync` with the fixture orderId returns counts.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement** the probe, routes (each resolves `const user = await getAuthUser(req); if (!user) return unauthorized()`, then `const actor = { id: user.id, name: user.name, role: user.role }`), and the `me` object `{ id, name, role, isLeader: isLeader(role) }`.

- [ ] **Step 4: Run — PASS**; full suite + tsc.

- [ ] **Step 5: Commit** `feat(design-tasks): task routes, settings and template endpoints, image size probe`

---

### Task 5: Design Tasks page (port of the approved demo)

**Files:**
- Replace: `src/app/design-studio/page.tsx`
- Create: `src/app/design-studio/components/Queue.tsx`, `TaskHeader.tsx`, `TemplateCanvas.tsx`, `ImagePanes.tsx`, `ArtworkSlots.tsx`, `LowerGrid.tsx`, `types.ts`, `ui.tsx` (pill, avatar, card helpers)
- Replace: `src/app/design-studio/[orderId]/page.tsx` with a redirect; delete `[orderId]/LineBlock.tsx` after moving its upload logic into `ArtworkSlots.tsx`

**Interfaces:**
- Consumes the Task 4 endpoints. Visual spec of record: `C:\Users\TMPC~1\AppData\Local\Temp\claude\D--Ecom-manager-ecommanager-claude-ecommerce-cashflow-tool-XsLzh\2b5d03eb-e8c6-4220-a127-6228a813b37e\scratchpad\ws-demo\template.html` — functions `renderQueue`, `customTable`, `templateSVG`, `paneTemplate/panePreview/paneMock`, `reqTable`, `lowerHTML`, `actionsHTML`, assign form and reject panel. Port each to the component of the same purpose; translate the demo's CSS tokens to the Tailwind tokens (`--brand` → `secondary`, `--panel` → `surface-container-lowest`, `--line` → `outline-variant/20`, pills → `bg-tertiary/15 text-tertiary` (ok) / `bg-amber-100 text-amber-900` (warn) / `bg-error-container text-on-error-container` (bad) / `bg-surface-container text-on-surface-variant` (idle) / `bg-secondary/10 text-secondary` (brand)).

- [ ] **Step 1: `types.ts`** — copy `TaskRow`, `TaskDetail`, `TemplateRow`, `WorkspaceLine`, `ArtworkRow` shapes from `src/lib/design-tasks.ts` / `design-studio.ts` (client-safe copies).
- [ ] **Step 2: `page.tsx`** — `'use client'`; state `{ sel: taskKey | null, filter, mine, q (debounced), detail }`; reads `?task=` from `useSearchParams` on load; loads `/api/design-studio/tasks` (all open statuses + DONE within today) and `/tasks/[key]`; layout `grid grid-cols-[290px_minmax(0,1fr)] gap-md`; left `<Queue>`, right `<TaskHeader>` + `<ImagePanes>` + flags + `<LowerGrid>`; a `reload()` passed down.
- [ ] **Step 3: `Queue.tsx`** — search, readiness chips, "Của tôi", grouped sections (`REJECTED → ASK_CUSTOMER → NEW+ASSIGNED → DOING → REVIEW → DONE`), rows per the demo (`renderQueue`), time-left from `dueAt` (`còn Xh` / red `quá Xh`), avatar initials from assignee name.
- [ ] **Step 4: `TaskHeader.tsx`** — pills, meta row, personalization table (`customTable`: `# · Trường · Giá trị (copy button) · Layer hint · Biến thể`), action row driven by `me.isLeader`, `task.status`, `task.readiness` exactly as `actionsHTML`; Leader assign form (assignee select from `assignable`, kpi, dueHours, note) → `POST transition {to:'ASSIGNED'}`; reject panel with reason chips from `settings.rejectReasons` → `{to:'REJECTED', reasons, note}`; ASK_CUSTOMER prompt for a note; "Tiếp tục" when status is ASK_CUSTOMER → `{to: prevStatus, continue: true}`.
- [ ] **Step 5: `TemplateCanvas.tsx`** — port `templateSVG`: SVG viewBox from `template.widthPx/heightPx` (scale to 1200 wide), grey panels from `areas`, bleed/safe dashed rects from `bleedIn/safeIn × dpi`, artguide `<image>` from `guideImageUrl` with opacity slider, background switch, the newest artwork per area drawn inside its panel (`<image href=artwork.url>` fit), or the first source print file drawn into the first area with the scale label when the slot has no artwork; px rulers. No template → placeholder card "Chưa có template cho SKU này".
- [ ] **Step 6: `ImagePanes.tsx`** — `grid grid-cols-[2.1fr_1fr_1fr] gap-md`, each pane with header + expand toggle (single-pane mode with chips to switch), panes: TemplateCanvas / preview (`line.previewUrl`) / mockup (newest artworks or source print files, Front/Back toggle when areas have Front*/Back* names).
- [ ] **Step 7: `ArtworkSlots.tsx`** — slots = template areas' names if a template exists else `line.printAreas`; versions newest first; picker + drag-drop → v1 upload route; busy guard; shows `widthPx×heightPx` when known.
- [ ] **Step 8: `LowerGrid.tsx`** — two columns: [ArtworkSlots, Xưởng & template card] / [Yêu cầu xưởng ↔ file table (template px/dpi vs newest artwork `widthPx×heightPx`; ✓/⚠/✗), Checklist (5 items; auto-tick "đủ file cho mọi panel" when every slot has a file and "độ nét" when newest artwork px ≥ area px), Trao đổi & lịch sử (events + composer → `POST events`)]. "Duyệt & gửi xưởng" button here mirrors the header action.
- [ ] **Step 9: `[orderId]/page.tsx`** → on mount fetch `/api/design-studio/tasks?q=<order number>`; `router.replace('/design-studio?task=' + first.taskKey)`; fall back to `/design-studio`.
- [ ] **Step 10: Verify** `npx tsc --noEmit -p .`, `npx next lint --dir src/app/design-studio`, `npx vitest run`. Then start the dev server with the Browser `preview_start { name: "ecom-manager" }`; if the login wall blocks, stop there and report; otherwise open `/design-studio`, run `POST /api/design-studio/tasks/sync` from the page's "Đồng bộ task" button (add a small button in the page header that posts `{}`), confirm the queue fills from dev.db, open a task, upload a PNG, mark done. Stop the server when finished.
- [ ] **Step 11: Commit** `feat(design-tasks): queue + image-first workspace page`

---

### Task 6: Docs

**Files:** `NOTES.md`, `PLAN.md`

- [ ] Append to NOTES.md a "Design Tasks v2 (2026-10-10, local)" section: task model and key format, lifecycle table, how tasks are created (sync hook + `POST /api/design-studio/tasks/sync`), permission `design_tasks`, settings key `design.settings`, template seed script and that area coordinates are illustrative, Review Focus list from this plan as "things that are pinned by tests". Add the PLAN.md line "Design Tasks v2 (local): task queue, lifecycle, assign/KPI, image-first workspace — 2026-10-10; next: Print Template editor, Drive storage, local render worker".
- [ ] `npx vitest run && npx tsc --noEmit -p .`; commit `docs(design-tasks): notes and plan entry`.
