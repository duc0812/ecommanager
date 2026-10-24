import { prisma } from '@/lib/db'
import type { CsSettings } from '@/lib/cs/settings'

export type TimelineStage = 'ORDER' | 'DESIGN' | 'FULFILLMENT' | 'FACTORY' | 'CARRIER'
export type TimelineEvent = { at: Date; stage: TimelineStage; label: string }
export type GapName = 'design' | 'handoff' | 'production' | 'transit' | 'stalled'
export type Gap = { name: GapName; days: number | null; budgetDays: number; late: boolean }
export type OrderTimeline = {
  orderId: string
  orderNumber: string
  legacy: boolean
  events: TimelineEvent[]
  gaps: Gap[]
  customerInputs: { lineId: string; title: string; fields: Record<string, string> }[]
  printFiles: { lineId: string; title: string; designDriveLink: string | null; designNote: string | null }[]
  shipments: { trackingNumber: string | null; status: string; firstScanAt: Date | null; lastScanAt: Date | null }[]
}

const DESIGN_BUDGET_DAYS = 2
const HANDOFF_BUDGET_DAYS = 2
const STALLED_DAYS = 7
const DAY = 86400_000

const daysBetween = (a: Date, b: Date) => Math.round(((b.getTime() - a.getTime()) / DAY) * 10) / 10

function parseAttrs(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    if (Array.isArray(v)) return Object.fromEntries(v.filter(x => x && typeof x.key === 'string').map(x => [x.key, String(x.value ?? '')]))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val ?? '')]))
  } catch {}
  return {}
}

function checkpointTimes(json: string | null): Date[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return arr.map((c: any) => new Date(c?.time ?? c?.date ?? '')).filter(d => !Number.isNaN(d.getTime())).sort((a, b) => a.getTime() - b.getTime())
  } catch { return [] }
}

export async function buildOrderTimeline(orderId: string, settings: Pick<CsSettings, 'productionDays' | 'shippingDays'>, now = new Date()): Promise<OrderTimeline | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      lines: { orderBy: { linePosition: 'asc' } },
      designTasks: { include: { events: { orderBy: { createdAt: 'asc' } } } },
      supplierPushes: { orderBy: { pushedAt: 'asc' } },
      shipments: true,
    },
  })
  if (!o) return null

  const events: TimelineEvent[] = [{ at: o.placedAt, stage: 'ORDER', label: 'order placed' }]
  const tasks = o.designTasks
  const legacy = tasks.length === 0 && !o.supplierHandoffAt
  let designStart: Date | null = null
  let designDone: Date | null = null
  if (tasks.length) {
    designStart = new Date(Math.min(...tasks.map(t => t.createdAt.getTime())))
    events.push({ at: designStart, stage: 'DESIGN', label: 'design task created' })
    const doneTimes = tasks.map(t => {
      if (t.status !== 'DONE') return null
      const ev = [...t.events].reverse().find(e => /DONE/.test(e.message) && (e.type === 'STATUS' || e.type === 'HANDOFF' || e.type === 'SYSTEM'))
      return ev?.createdAt ?? t.updatedAt
    })
    if (doneTimes.every(d => d)) {
      designDone = new Date(Math.max(...doneTimes.map(d => d!.getTime())))
      events.push({ at: designDone, stage: 'DESIGN', label: 'design DONE' })
    } else {
      const open = tasks.filter(t => t.status !== 'DONE').map(t => t.status).join(', ')
      events.push({ at: now, stage: 'DESIGN', label: `design still open (${open})` })
    }
  }

  const livePush = o.supplierPushes.find(p => p.status === 'CREATED' || p.status === 'SENDING')
  const handoffAt = o.supplierHandoffAt ?? livePush?.pushedAt ?? o.exportedAt ?? null
  if (handoffAt) {
    const how = o.supplierHandoffAt ? (o.supplierHandoffMode === 'API' ? 'handed to factory (API)' : 'handed to factory (CSV)') : livePush ? 'handed to factory (API push)' : 'exported to factory (CSV)'
    events.push({ at: handoffAt, stage: 'FULFILLMENT', label: how })
  }
  if (livePush) events.push({ at: livePush.pushedAt, stage: 'FACTORY', label: `factory push ${livePush.status}${livePush.remoteStatus ? `, remote ${livePush.remoteStatus}` : ''}` })

  const shipments = o.shipments.map(s => {
    const times = checkpointTimes(s.checkpointsJson)
    const firstScanAt = times[0] ?? s.lastCheckpointAt ?? null
    const lastScanAt = times.length ? times[times.length - 1] : s.lastCheckpointAt ?? null
    return { trackingNumber: s.trackingNumber, status: s.status, firstScanAt, lastScanAt }
  })
  const firstScan = shipments.map(s => s.firstScanAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null
  const lastScan = shipments.map(s => s.lastScanAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
  if (firstScan) events.push({ at: firstScan, stage: 'CARRIER', label: `first scan (${shipments.map(s => s.trackingNumber).filter(Boolean).join(', ')})` })
  if (lastScan && (!firstScan || lastScan.getTime() !== firstScan.getTime())) events.push({ at: lastScan, stage: 'CARRIER', label: `last scan, status ${shipments.map(s => s.status).join('/')}` })
  const delivered = shipments.length > 0 && shipments.every(s => s.status === 'DELIVERED')

  const gaps: Gap[] = []
  if (designStart) {
    const end = designDone ?? now
    const d = daysBetween(designStart, end)
    gaps.push({ name: 'design', days: d, budgetDays: DESIGN_BUDGET_DAYS, late: d > DESIGN_BUDGET_DAYS })
  }
  if (designDone) {
    const d = daysBetween(designDone, handoffAt ?? now)
    gaps.push({ name: 'handoff', days: d, budgetDays: HANDOFF_BUDGET_DAYS, late: d > HANDOFF_BUDGET_DAYS })
  }
  if (handoffAt) {
    if (!firstScan && shipments.length) gaps.push({ name: 'production', days: null, budgetDays: settings.productionDays, late: false })
    else {
      const d = daysBetween(handoffAt, firstScan ?? now)
      gaps.push({ name: 'production', days: d, budgetDays: settings.productionDays, late: d > settings.productionDays })
    }
  }
  if (firstScan) {
    const d = daysBetween(firstScan, delivered ? lastScan ?? now : now)
    gaps.push({ name: 'transit', days: d, budgetDays: settings.shippingDays, late: !delivered && d > settings.shippingDays })
    if (!delivered && lastScan) {
      const s = daysBetween(lastScan, now)
      gaps.push({ name: 'stalled', days: s, budgetDays: STALLED_DAYS, late: s >= STALLED_DAYS })
    }
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime())
  return {
    orderId: o.id,
    orderNumber: o.shopifyOrderNumber,
    legacy,
    events,
    gaps,
    customerInputs: o.lines.filter(l => l.customAttributesJson).map(l => ({ lineId: l.shopifyLineId, title: l.productTitle, fields: parseAttrs(l.customAttributesJson) })),
    printFiles: o.lines.map(l => ({ lineId: l.shopifyLineId, title: l.productTitle, designDriveLink: l.designDriveLink, designNote: l.designNote })),
    shipments,
  }
}

const fmt = (d: Date) => `${d.toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' })} ${d.toISOString().slice(11, 16)}`

export function formatTimeline(t: OrderTimeline): string {
  const lines: string[] = []
  lines.push(`order ${t.orderNumber}${t.legacy ? ' (no design timeline — order predates Design Studio; hand-off = CSV export)' : ''}`)
  for (const e of t.events) lines.push(`${fmt(e.at)} · ${e.stage} · ${e.label}`)
  if (t.gaps.length) {
    lines.push('gaps: ' + t.gaps.map(g => `${g.name} ${g.days === null ? '?' : `${g.days} d`} (budget ${g.budgetDays}${g.late ? ' — LATE' : ''})`).join(' · '))
  }
  for (const c of t.customerInputs) {
    const fields = Object.entries(c.fields).map(([k, v]) => `${k} = "${v}"`).join(', ')
    if (fields) lines.push(`customer typed (${c.title}): ${fields}`)
  }
  for (const p of t.printFiles) {
    if (p.designDriveLink || p.designNote) lines.push(`print file (${p.title}): ${p.designDriveLink ?? 'no link'}${p.designNote ? ` · note: ${p.designNote}` : ''}`)
  }
  if (!t.shipments.length) lines.push('shipments: none yet')
  return lines.join('\n')
}
