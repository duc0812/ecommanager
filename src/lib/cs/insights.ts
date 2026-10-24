import { prisma } from '@/lib/db'
import { weekBounds } from '@/lib/cs/performance'

export type InsightsFilter = { from: Date; to: Date; stage?: string; category?: string }
export type InsightsRow = {
  ticketId: string
  fdTicketId: number
  subject: string
  orderNumber: string | null
  stage: string
  issueType: string | null
  confidence: string | null
  evidence: string | null
  category: string | null
  createdAt: Date
  products: string[]
  supplierId: string | null
  overridden: boolean
}
export type Insights = {
  totals: { problem: number; all: number; topStage: string | null; topIssue: string | null }
  byStage: Record<string, number>
  byIssue: Record<string, number>
  weekly: { week: string; byStage: Record<string, number> }[]
  products: { title: string; count: number }[]
  suppliers: { supplierId: string; name: string | null; count: number }[]
  rows: InsightsRow[]
}

const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1 }
const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

export async function insights(f: InsightsFilter): Promise<Insights> {
  const tickets = await prisma.csTicket.findMany({
    where: { lastCustomerAt: { gte: f.from, lte: f.to } },
    include: { analyses: { orderBy: { runAt: 'desc' }, take: 1 } },
  })
  const orderIds = Array.from(new Set(tickets.map(t => t.orderId).filter((x): x is string => !!x)))
  const orders = orderIds.length
    ? await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, exportedToSupplierId: true, lines: { select: { shopifyLineId: true, productTitle: true } }, supplierPushes: { select: { supplierId: true }, orderBy: { pushedAt: 'desc' }, take: 1 } } })
    : []
  const orderById = new Map(orders.map(o => [o.id, o]))
  const supplierIds = Array.from(new Set(orders.map(o => o.supplierPushes[0]?.supplierId ?? o.exportedToSupplierId).filter((x): x is string => !!x)))
  const suppliers = supplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : []
  const supplierName = new Map(suppliers.map(s => [s.id, s.name]))

  const rows: InsightsRow[] = []
  for (const t of tickets) {
    const a = t.analyses[0]
    const stage = t.rootCauseStageOverride ?? a?.rootCauseStage ?? null
    if (!stage) continue
    if (f.stage && stage !== f.stage) continue
    if (f.category && t.category !== f.category) continue
    const order = t.orderId ? orderById.get(t.orderId) : undefined
    const affected: string[] = a ? (() => { try { return JSON.parse(a.affectedLineIds) } catch { return [] } })() : []
    const lines = order ? (affected.length ? order.lines.filter(l => affected.includes(l.shopifyLineId)) : order.lines) : []
    rows.push({
      ticketId: t.id,
      fdTicketId: t.fdTicketId,
      subject: t.subject,
      orderNumber: t.orderNumber,
      stage,
      issueType: a?.issueType ?? null,
      confidence: t.rootCauseStageOverride ? 'OVERRIDE' : a?.rootCauseConfidence ?? null,
      evidence: t.rootCauseNote ?? a?.rootCauseEvidence ?? null,
      category: t.category,
      createdAt: t.lastCustomerAt ?? t.fdCreatedAt,
      products: Array.from(new Set((lines.length ? lines : order?.lines ?? []).map(l => l.productTitle))),
      supplierId: order ? order.supplierPushes[0]?.supplierId ?? order.exportedToSupplierId ?? null : null,
      overridden: !!t.rootCauseStageOverride,
    })
  }
  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  const byStage: Record<string, number> = {}
  const byIssue: Record<string, number> = {}
  const products: Record<string, number> = {}
  const supplierCounts: Record<string, number> = {}
  const weeks = new Map<string, Record<string, number>>()
  for (const r of rows) {
    inc(byStage, r.stage)
    if (r.issueType) inc(byIssue, r.issueType)
    for (const p of r.products) inc(products, p)
    if (r.supplierId) inc(supplierCounts, r.supplierId)
    const w = weekBounds(r.createdAt).from.toISOString().slice(0, 10)
    if (!weeks.has(w)) weeks.set(w, {})
    inc(weeks.get(w)!, r.stage)
  }
  return {
    totals: { problem: rows.length, all: tickets.length, topStage: top(byStage), topIssue: top(byIssue) },
    byStage,
    byIssue,
    weekly: Array.from(weeks.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([week, s]) => ({ week, byStage: s })),
    products: Object.entries(products).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([title, count]) => ({ title, count })),
    suppliers: Object.entries(supplierCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([supplierId, count]) => ({ supplierId, name: supplierName.get(supplierId) ?? null, count })),
    rows,
  }
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function insightsCsv(rows: InsightsRow[]): string {
  const header = ['ticket', 'order', 'stage', 'issueType', 'confidence', 'category', 'date', 'products', 'supplierId', 'evidence']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([r.fdTicketId, r.orderNumber, r.stage, r.issueType, r.confidence, r.category, r.createdAt.toISOString().slice(0, 10), r.products.join(' | '), r.supplierId, r.evidence].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}

export function parsePeriod(params: URLSearchParams, now = new Date()): { from: Date; to: Date } {
  const from = params.get('from') ? new Date(params.get('from')!) : weekBounds(now, -3).from
  const to = params.get('to') ? new Date(params.get('to')!) : weekBounds(now).to
  return { from: Number.isNaN(from.getTime()) ? weekBounds(now, -3).from : from, to: Number.isNaN(to.getTime()) ? weekBounds(now).to : to }
}
