# Other Bills Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 22-field accounting-heavy Other Bills form with a 10-field expense tracker focused on recording paid subscriptions, app fees, and office costs.

**Architecture:** New currency utility for USD/VND conversion → schema migration (drop & recreate OtherBill) → rewrite GET/POST API routes → full page UI rewrite. No data migration needed — no existing records.

**Tech Stack:** Next.js (App Router, `'use client'`), Prisma 7 (libsql adapter), Vitest, Tailwind CSS design tokens, Material Symbols Outlined icons.

---

### Task 1: Currency Utility (TDD)

**Files:**
- Create: `src/lib/currency.ts`
- Create: `src/lib/currency.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/currency.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { calcAmountUsd } from './currency'

describe('calcAmountUsd', () => {
  it('returns amount unchanged for USD', () => {
    expect(calcAmountUsd({ amount: 29.99, currency: 'USD' })).toBe(29.99)
  })

  it('converts VND to USD using exchange rate', () => {
    expect(calcAmountUsd({ amount: 254000, currency: 'VND', exchangeRate: 25400 })).toBe(10)
  })

  it('rounds VND conversion to 2 decimal places', () => {
    expect(calcAmountUsd({ amount: 100000, currency: 'VND', exchangeRate: 25400 })).toBe(3.94)
  })

  it('throws if currency is VND and exchangeRate is missing', () => {
    expect(() => calcAmountUsd({ amount: 100000, currency: 'VND' })).toThrow('exchangeRate required')
  })

  it('throws if currency is VND and exchangeRate is zero', () => {
    expect(() => calcAmountUsd({ amount: 100000, currency: 'VND', exchangeRate: 0 })).toThrow('exchangeRate required')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx vitest run src/lib/currency.test.ts
```

Expected: FAIL with "Cannot find module './currency'"

- [ ] **Step 3: Implement the utility**

Create `src/lib/currency.ts`:

```typescript
export type CalcAmountUsdInput = {
  amount: number
  currency: string
  exchangeRate?: number
}

export function calcAmountUsd({ amount, currency, exchangeRate }: CalcAmountUsdInput): number {
  if (currency === 'VND') {
    if (!exchangeRate || exchangeRate <= 0) throw new Error('exchangeRate required for VND')
    return Math.round((amount / exchangeRate) * 100) / 100
  }
  return amount
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/currency.test.ts
```

Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/currency.ts src/lib/currency.test.ts
git commit -m "feat: add currency utility for USD/VND conversion"
```

---

### Task 2: Prisma Schema Migration

**Files:**
- Modify: `prisma/schema.prisma` (lines 136–146 Staff model, lines 200–240 OtherBill model)
- Modify: `src/lib/db.ts` (line 6, SCHEMA_VERSION)

- [ ] **Step 1: Remove `otherBills` from Staff model**

In `prisma/schema.prisma`, find the Staff model (line 136). Remove line 144:

```prisma
// REMOVE this line from the Staff model:
otherBills   OtherBill[]
```

The Staff model after the edit:
```prisma
model Staff {
  id          String            @id @default(cuid())
  name        String
  role        String?
  monthlyCost Float             @default(0)
  note        String?
  createdAt   DateTime          @default(now())
  assignments StaffAssignment[]
  fulfillmentCosts FulfillmentCost[]
}
```

- [ ] **Step 2: Replace the OtherBill model**

Replace the entire OtherBill model (lines 200–240) with:

```prisma
model OtherBill {
  id            String   @id @default(cuid())
  vendor        String
  category      String
  amount        Float
  currency      String   @default("USD")
  amountUsd     Float
  exchangeRate  Float?
  paidAt        String
  paymentMethod String
  transactionId String?
  note          String?
  tags          String   @default("[]")
  projectId     String?
  project       Project? @relation(fields: [projectId], references: [id])
  createdAt     DateTime @default(now())

  @@index([paidAt])
  @@index([category])
  @@index([projectId])
}
```

- [ ] **Step 3: Run the migration**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --name simplify-other-bills
```

Expected: Migration created and applied. If prompted about data loss, confirm with `y` — there is no data to preserve.

- [ ] **Step 4: Regenerate the Prisma client**

```bash
npx prisma generate
```

Expected: Generated Prisma Client to `src/generated/prisma`

- [ ] **Step 5: Bump SCHEMA_VERSION**

In `src/lib/db.ts` line 6, change:
```typescript
const SCHEMA_VERSION = 'v20'
```
to:
```typescript
const SCHEMA_VERSION = 'v21'
```

- [ ] **Step 6: Commit**

```bash
git add prisma/ src/lib/db.ts src/generated/
git commit -m "feat: simplify OtherBill schema - remove accounting fields"
```

---

### Task 3: Rewrite API Routes

**Files:**
- Rewrite: `src/app/api/finance/other-bills/route.ts`
- Modify: `src/app/api/finance/other-bills/[id]/route.ts` (remove PATCH)

- [ ] **Step 1: Rewrite `route.ts`**

Replace the entire contents of `src/app/api/finance/other-bills/route.ts` with:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { calcAmountUsd } from '@/lib/currency'

const CATEGORIES = ['APP_TOOL', 'SUBSCRIPTION', 'OFFICE', 'OTHER'] as const
const PAYMENT_METHODS = ['CK', 'PINGPONG', 'PO', 'OTHER'] as const

function monthRange(month: string | null) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null
  const [y, m] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getDate()
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const month = monthRange(searchParams.get('month'))
  const projectId = searchParams.get('projectId')
  const category = searchParams.get('category')
  const paymentMethod = searchParams.get('paymentMethod')

  const where = {
    ...(month ? { paidAt: { gte: month.start, lte: month.end } } : {}),
    ...(projectId && projectId !== 'all' ? { projectId } : {}),
    ...(category && category !== 'all' ? { category } : {}),
    ...(paymentMethod && paymentMethod !== 'all' ? { paymentMethod } : {}),
  }

  const [bills, projects] = await Promise.all([
    prisma.otherBill.findMany({
      where,
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      include: { project: { select: { id: true, name: true } } },
    }),
    prisma.project.findMany({ orderBy: { name: 'asc' } }),
  ])

  const totalUsd = bills.reduce((sum, b) => sum + b.amountUsd, 0)
  const byCategory = CATEGORIES.map(cat => ({
    category: cat,
    totalUsd: bills.filter(b => b.category === cat).reduce((sum, b) => sum + b.amountUsd, 0),
    count: bills.filter(b => b.category === cat).length,
  })).filter(row => row.count > 0)

  const distinctProjects = new Set(bills.map(b => b.projectId).filter(Boolean)).size

  return NextResponse.json({
    bills,
    projects,
    stats: { totalUsd, count: bills.length, byCategory, distinctProjects },
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { vendor, category, amount, currency = 'USD', exchangeRate, paidAt, paymentMethod, transactionId, note, tags, projectId } = body

  const errors: string[] = []
  if (!vendor?.trim()) errors.push('vendor required')
  if (!CATEGORIES.includes(category)) errors.push('invalid category')
  if (!amount || Number(amount) <= 0) errors.push('amount must be > 0')
  if (!paidAt?.trim()) errors.push('paidAt required')
  if (!PAYMENT_METHODS.includes(paymentMethod)) errors.push('invalid paymentMethod')
  if (currency === 'VND' && (!exchangeRate || Number(exchangeRate) <= 0)) errors.push('exchangeRate required for VND')

  if (errors.length > 0) return NextResponse.json({ error: errors.join(', ') }, { status: 400 })

  const amountUsd = calcAmountUsd({ amount: Number(amount), currency, exchangeRate: exchangeRate ? Number(exchangeRate) : undefined })

  const bill = await prisma.otherBill.create({
    data: {
      vendor: vendor.trim(),
      category,
      amount: Number(amount),
      currency,
      amountUsd,
      exchangeRate: exchangeRate ? Number(exchangeRate) : null,
      paidAt,
      paymentMethod,
      transactionId: transactionId?.trim() || null,
      note: note?.trim() || null,
      tags: tags || '[]',
      projectId: projectId || null,
    },
  })

  return NextResponse.json({ ok: true, bill })
}
```

- [ ] **Step 2: Remove PATCH from `[id]/route.ts`**

Replace the entire contents of `src/app/api/finance/other-bills/[id]/route.ts` with:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.otherBill.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx tsc --noEmit
```

Expected: No errors related to OtherBill or other-bills routes.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/finance/other-bills/
git commit -m "feat: rewrite other-bills API - simple expense tracker endpoints"
```

---

### Task 4: Rewrite Page UI

**Files:**
- Rewrite: `src/app/finance/other-bills/page.tsx`

- [ ] **Step 1: Rewrite the page**

Replace the entire contents of `src/app/finance/other-bills/page.tsx` with:

```typescript
'use client'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Project = { id: string; name: string }
type OtherBill = {
  id: string
  vendor: string
  category: string
  amount: number
  currency: string
  amountUsd: number
  exchangeRate: number | null
  paidAt: string
  paymentMethod: string
  transactionId: string | null
  note: string | null
  tags: string
  project: Project | null
}

type Data = {
  bills: OtherBill[]
  projects: Project[]
  stats: {
    totalUsd: number
    count: number
    byCategory: { category: string; totalUsd: number; count: number }[]
    distinctProjects: number
  }
}

const CATEGORIES: [string, string][] = [
  ['APP_TOOL', 'App & Tool'],
  ['SUBSCRIPTION', 'Subscription'],
  ['OFFICE', 'Văn phòng'],
  ['OTHER', 'Khác'],
]

const PAYMENT_METHODS: [string, string][] = [
  ['CK', 'Chuyển khoản'],
  ['PINGPONG', 'PingPong'],
  ['PO', 'PO'],
  ['OTHER', 'Khác'],
]

const TAG_COLORS = [
  'bg-secondary/10 text-secondary',
  'bg-tertiary/10 text-tertiary',
  'bg-on-tertiary-container/10 text-on-tertiary-container',
  'bg-error/10 text-error',
  'bg-surface-container text-on-surface-variant',
]

function tagColor(tag: string) {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) & 0xffffffff
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length]
}

function parseTags(raw: string): string[] {
  try { return JSON.parse(raw) } catch { return [] }
}

function today() {
  return new Date().toISOString().split('T')[0]
}

function fmtUSD(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n || 0)
}

function fmtDate(s: string) {
  return new Date(`${s}T00:00:00`).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function catLabel(c: string) {
  return CATEGORIES.find(([v]) => v === c)?.[1] ?? c
}

function methodLabel(m: string) {
  return PAYMENT_METHODS.find(([v]) => v === m)?.[1] ?? m
}

export default function OtherBillsPage() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [filters, setFilters] = useState({ month: '', projectId: 'all', category: 'all', paymentMethod: 'all' })

  // form state
  const [currency, setCurrency] = useState('USD')
  const [exchangeRate, setExchangeRate] = useState('')
  const [amount, setAmount] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (filters.month) params.set('month', filters.month)
    if (filters.projectId !== 'all') params.set('projectId', filters.projectId)
    if (filters.category !== 'all') params.set('category', filters.category)
    if (filters.paymentMethod !== 'all') params.set('paymentMethod', filters.paymentMethod)
    const res = await fetch(`/api/finance/other-bills?${params}`)
    setData(await res.json())
    setLoading(false)
  }, [filters])

  useEffect(() => { load() }, [load])

  function addTag(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const t = tagInput.trim()
    if (t && !tags.includes(t)) setTags([...tags, t])
    setTagInput('')
  }

  function removeTag(t: string) {
    setTags(tags.filter(x => x !== t))
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    const form = new FormData(e.currentTarget)
    const body: Record<string, any> = {
      vendor: form.get('vendor'),
      category: form.get('category'),
      amount: Number(form.get('amount')),
      currency,
      paidAt: form.get('paidAt'),
      paymentMethod: form.get('paymentMethod'),
      transactionId: form.get('transactionId') || null,
      note: form.get('note') || null,
      tags: JSON.stringify(tags),
      projectId: form.get('projectId') || null,
    }
    if (currency === 'VND') body.exchangeRate = Number(exchangeRate)

    const res = await fetch('/api/finance/other-bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!res.ok) {
      setMessage(json.error || 'Lỗi khi lưu')
      setSaving(false)
      return
    }
    e.currentTarget.reset()
    setCurrency('USD')
    setExchangeRate('')
    setAmount('')
    setTags([])
    setTagInput('')
    setMessage('Đã lưu thành công.')
    await load()
    setSaving(false)
  }

  async function deleteBill(id: string) {
    if (!confirm('Xóa chi phí này?')) return
    await fetch(`/api/finance/other-bills/${id}`, { method: 'DELETE' })
    await load()
  }

  const projects = data?.projects ?? []
  const stats = data?.stats
  const topCat = stats?.byCategory.sort((a, b) => b.totalUsd - a.totalUsd)[0]

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <h2 className="text-display-md font-bold text-primary">Other Bills</h2>
          <p className="text-on-surface-variant text-body-md mt-xs">Ghi nhận các chi phí đã thanh toán: app, subscription, văn phòng...</p>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-xl items-start">
          {/* ── Add Form ── */}
          <form onSubmit={submit} className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
            <div className="px-lg py-md border-b border-outline-variant/20 flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">add_card</span>
              <h3 className="text-headline-sm text-primary">Thêm chi phí</h3>
            </div>
            <div className="p-lg space-y-md">
              <Field label="Nhà cung cấp *">
                <input name="vendor" required className={inputCls} />
              </Field>

              <div className="grid grid-cols-2 gap-md">
                <Field label="Danh mục *">
                  <select name="category" required className={inputCls}>
                    <option value="">-- Chọn --</option>
                    {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
                <Field label="Phương thức *">
                  <select name="paymentMethod" required className={inputCls}>
                    <option value="">-- Chọn --</option>
                    {PAYMENT_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-md">
                <Field label="Ngày thanh toán *">
                  <input name="paidAt" type="date" required defaultValue={today()} className={inputCls} />
                </Field>
                <Field label="Tiền tệ *">
                  <select value={currency} onChange={e => { setCurrency(e.target.value); setExchangeRate('') }} className={inputCls}>
                    <option value="USD">USD</option>
                    <option value="VND">VND</option>
                  </select>
                </Field>
              </div>

              <Field label={`Số tiền * (${currency})`}>
                <div>
                  <input
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className={inputCls}
                  />
                  {currency === 'VND' && Number(exchangeRate) > 0 && Number(amount) > 0 && (
                    <p className="text-label-sm text-secondary mt-xs">
                      ≈ {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.round((Number(amount) / Number(exchangeRate)) * 100) / 100)} USD
                    </p>
                  )}
                </div>
              </Field>

              {currency === 'VND' && (
                <Field label="Tỷ giá (VND / 1 USD) *">
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={exchangeRate}
                    onChange={e => setExchangeRate(e.target.value)}
                    placeholder="vd: 25400"
                    className={inputCls}
                  />
                </Field>
              )}

              <Field label="Transaction ID">
                <input name="transactionId" className={inputCls} />
              </Field>

              <Field label="Ghi chú">
                <textarea name="note" rows={2} className={`${inputCls} resize-none`} />
              </Field>

              <Field label="Tags">
                <div className="flex flex-wrap gap-xs mb-xs">
                  {tags.map(t => (
                    <span key={t} className={`${tagColor(t)} rounded-full px-sm py-xs text-label-sm flex items-center gap-xs`}>
                      {t}
                      <button type="button" onClick={() => removeTag(t)} className="opacity-60 hover:opacity-100">×</button>
                    </span>
                  ))}
                </div>
                <input
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={addTag}
                  placeholder="Nhập tag rồi Enter..."
                  className={inputCls}
                />
              </Field>

              <Field label="Dự án">
                <select name="projectId" className={inputCls}>
                  <option value="">-- Không có --</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>

              {message && (
                <p className={`text-body-sm ${message.includes('thành công') ? 'text-on-tertiary-container' : 'text-error'}`}>{message}</p>
              )}

              <button disabled={saving} className="w-full bg-secondary text-on-secondary rounded-lg py-md text-label-md font-semibold disabled:opacity-50">
                {saving ? 'Đang lưu...' : 'Lưu chi phí'}
              </button>
            </div>
          </form>

          {/* ── Right column ── */}
          <section className="space-y-lg">
            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-lg">
              <StatCard icon="payments" label="Tháng này" value={fmtUSD(stats?.totalUsd ?? 0)} hint={`${stats?.count ?? 0} giao dịch`} />
              <StatCard icon="receipt_long" label="Tổng giao dịch" value={String(stats?.count ?? 0)} hint="đã ghi nhận" />
              <StatCard icon="category" label="Danh mục nhiều nhất" value={topCat ? catLabel(topCat.category) : '-'} hint={topCat ? fmtUSD(topCat.totalUsd) : '-'} />
              <StatCard icon="folder" label="Dự án" value={String(stats?.distinctProjects ?? 0)} hint="có chi phí" />
            </div>

            {/* Filters */}
            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
              <div className="flex items-center gap-md flex-wrap">
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant">filter_alt</span>
                <input type="month" value={filters.month} onChange={e => setFilters({ ...filters, month: e.target.value })}
                  className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none" />
                <select value={filters.category} onChange={e => setFilters({ ...filters, category: e.target.value })}
                  className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none">
                  <option value="all">Tất cả danh mục</option>
                  {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <select value={filters.paymentMethod} onChange={e => setFilters({ ...filters, paymentMethod: e.target.value })}
                  className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none">
                  <option value="all">Tất cả phương thức</option>
                  {PAYMENT_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <select value={filters.projectId} onChange={e => setFilters({ ...filters, projectId: e.target.value })}
                  className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm outline-none">
                  <option value="all">Tất cả dự án</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>

            {/* Bill table */}
            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
              <div className="px-lg py-md border-b border-outline-variant/20 flex items-center gap-sm">
                <span className="material-symbols-outlined text-secondary">receipt_long</span>
                <h3 className="text-headline-sm text-primary">Chi phí</h3>
              </div>
              {loading ? (
                <div className="py-xl text-center text-on-surface-variant">Đang tải...</div>
              ) : !data || data.bills.length === 0 ? (
                <div className="py-xl text-center text-on-surface-variant">Chưa có chi phí nào.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-outline-variant/20 bg-surface-container-low/40">
                        {['Nhà cung cấp', 'Danh mục', 'Số tiền', 'Ngày', 'Thanh toán', 'Tags', 'Dự án', ''].map(h => (
                          <th key={h} className="text-left px-lg py-sm text-label-sm text-on-surface-variant uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/10">
                      {data.bills.map(bill => {
                        const billTags = parseTags(bill.tags)
                        return (
                          <tr key={bill.id} className="hover:bg-surface-container-low/40">
                            <td className="px-lg py-md">
                              <p className="text-label-md text-primary font-semibold">{bill.vendor}</p>
                              {bill.note && <p className="text-label-sm text-on-surface-variant">{bill.note}</p>}
                            </td>
                            <td className="px-lg py-md">
                              <span className="bg-secondary/10 text-secondary rounded-full px-sm py-xs text-label-sm whitespace-nowrap">{catLabel(bill.category)}</span>
                            </td>
                            <td className="px-lg py-md whitespace-nowrap">
                              <p className="text-label-md text-primary">{fmtUSD(bill.amountUsd)}</p>
                              {bill.currency === 'VND' && (
                                <p className="text-label-sm text-on-surface-variant">{bill.amount.toLocaleString('vi-VN')} VND</p>
                              )}
                            </td>
                            <td className="px-lg py-md text-body-sm text-on-surface-variant whitespace-nowrap">{fmtDate(bill.paidAt)}</td>
                            <td className="px-lg py-md">
                              <p className="text-label-sm text-on-surface-variant">{methodLabel(bill.paymentMethod)}</p>
                              {bill.transactionId && <p className="text-label-sm text-on-surface-variant font-mono">{bill.transactionId}</p>}
                            </td>
                            <td className="px-lg py-md">
                              <div className="flex flex-wrap gap-xs max-w-[180px]">
                                {billTags.length === 0
                                  ? <span className="text-on-surface-variant">-</span>
                                  : billTags.map(t => (
                                      <span key={t} className={`${tagColor(t)} rounded-full px-sm py-xs text-label-sm`}>{t}</span>
                                    ))}
                              </div>
                            </td>
                            <td className="px-lg py-md">
                              {bill.project
                                ? <span className="text-label-sm text-on-surface-variant">{bill.project.name}</span>
                                : <span className="text-on-surface-variant">-</span>}
                            </td>
                            <td className="px-lg py-md">
                              <button onClick={() => deleteBill(bill.id)} className="text-error text-label-sm hover:underline">Xóa</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
    </RoleGate>
  )
}

const inputCls = 'w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-label-sm text-on-surface-variant mb-xs">{label}</span>
      {children}
    </label>
  )
}

function StatCard({ icon, label, value, hint }: { icon: string; label: string; value: string; hint: string }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
      <div className="flex items-center gap-sm mb-sm">
        <span className="material-symbols-outlined text-[18px] text-secondary">{icon}</span>
        <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</span>
      </div>
      <p className="text-stats-lg text-primary">{value}</p>
      <p className="text-label-sm mt-xs text-on-surface-variant">{hint}</p>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx tsc --noEmit
```

Expected: No errors in `src/app/finance/other-bills/page.tsx`.

- [ ] **Step 3: Manual smoke test**

Start dev server and visit `http://localhost:3002/finance/other-bills`:
- Form shows 10 fields (no accounting jargon)
- Adding a USD expense saves and appears in table with correct `$X.XX` amount
- Switching currency to VND shows "Tỷ giá" field and live "≈ $X.XX USD" preview
- Tags chip input: type tag name + Enter to add, click × to remove
- Delete button shows confirm dialog, then removes the row
- Stats update after each save

- [ ] **Step 4: Commit**

```bash
git add src/app/finance/other-bills/page.tsx
git commit -m "feat: rewrite Other Bills UI - simple 10-field expense tracker"
```
