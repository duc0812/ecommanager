import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { loadWorkspace, type Workspace } from '@/lib/design-studio'
import { requiredSlotsFor, taskKeyFor, templateForLine } from '@/lib/design-tasks'
import { STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'
import { countryCodeOf, countryNameOf } from '@/lib/shipping-address'
import { credentialsOf, getPgprintsSettings } from '@/lib/pgprints-settings'
import { isPgprintsSupplier } from '@/lib/pgprints-shared'
import { activePushByOrder, logHandoffEvent } from '@/lib/repos/push-export'
import type { HandoffCard, HandoffLine, HandoffState } from '@/lib/handoff-shared'

export class HandoffError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'HandoffError'
  }
}

const OPEN_TASK = { status: { notIn: ['DONE', 'CANCELLED'] } }
const NOT_FULFILLED = { OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { notIn: ['fulfilled', 'FULFILLED'] } }] }
const CLOSED_FINANCIAL = ['REFUNDED', 'VOIDED']
const AFTER_EXPORT = ['EXPORTED', 'FULFILLED']
const PGPRINTS_NAME = 'PGprints'
const MAX_CARDS = 150

/** "Chờ chuyển xưởng": every design is approved, nothing was handed to the supplier yet, and the order is still open. */
export function pendingHandoffWhere() {
  return {
    pipelineStatus: 'READY_TO_PRODUCTION',
    designReady: true,
    supplierHandoffAt: null,
    designTasks: { none: OPEN_TASK },
    AND: [NOT_FULFILLED, { financialStatus: { notIn: [...CLOSED_FINANCIAL, ...CLOSED_FINANCIAL.map(s => s.toLowerCase())] } }],
  }
}

function savedForCsvWhere() {
  return { pipelineStatus: 'READY_TO_PRODUCTION', supplierHandoffMode: 'CSV', supplierHandoffAt: { not: null } }
}

export async function countPendingHandoff(): Promise<number> {
  return prisma.order.count({ where: pendingHandoffWhere() })
}

type StateOrder = {
  id: string; pipelineStatus: string; financialStatus: string; fulfillmentStatus: string | null; designReady: boolean
  supplierHandoffAt: Date | null; supplierHandoffMode: string | null; supplierHandoffById: string | null
  lines: Array<{ sku: string | null; productTitle: string; shopifyProductType: string | null; resolvedSupplierId: string | null; resolvedSupplierSku: string | null }>
  designTasks: Array<{ status: string }>
}

function blockedReason(o: StateOrder, openTasks: number): string {
  if (['CANCELLED', 'REFUNDED'].includes(o.pipelineStatus) || CLOSED_FINANCIAL.includes((o.financialStatus ?? '').toUpperCase())) return 'Đơn đã huỷ hoặc hoàn tiền'
  if (o.pipelineStatus === 'EXPORTED') return 'Đơn đã Exported'
  if (o.pipelineStatus === 'FULFILLED' || (o.fulfillmentStatus ?? '').toUpperCase() === 'FULFILLED') return 'Đơn đã giao'
  if (openTasks > 0) return `Còn ${openTasks} dòng chưa duyệt design`
  if (!o.designReady) return 'Còn dòng chưa có design được duyệt'
  return `Đơn đang ở trạng thái "${STATUS_LABELS[o.pipelineStatus as PipelineStatus] ?? o.pipelineStatus}"`
}

const STATE_INCLUDE = {
  lines: { select: { sku: true, productTitle: true, shopifyProductType: true, resolvedSupplierId: true, resolvedSupplierSku: true } },
  designTasks: { select: { status: true } },
} as const

export async function handoffStates(orders: StateOrder[]): Promise<Map<string, HandoffState>> {
  const out = new Map<string, HandoffState>()
  if (orders.length === 0) return out
  const [suppliers, settings, pushes] = await Promise.all([
    prisma.supplier.findMany({ select: { id: true, code: true, apiType: true, isActive: true } }),
    getPgprintsSettings(),
    activePushByOrder(orders.map(o => o.id)),
  ])
  const pgHits = suppliers.filter(isPgprintsSupplier)
  const pg = pgHits.find(s => s.isActive) ?? pgHits[0] ?? null
  const hasCredentials = !!credentialsOf(settings)
  const pgSkus = pg
    ? Array.from(new Set(orders.flatMap(o => o.lines.filter(l => l.resolvedSupplierId === pg.id).map(l => l.resolvedSupplierSku).filter((x): x is string => !!x))))
    : []
  const products = pg && pgSkus.length
    ? await prisma.supplierProduct.findMany({ where: { supplierId: pg.id, sku: { in: pgSkus } }, select: { sku: true, apiSku: true } })
    : []
  const apiSkuBySku = new Map(products.map(p => [p.sku, p.apiSku?.trim() || null]))
  const userIds = Array.from(new Set(orders.map(o => o.supplierHandoffById).filter((x): x is string => !!x)))
  const users = userIds.length ? await prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
  const nameById = new Map(users.map(u => [u.id, u.name]))

  for (const o of orders) {
    const productLines = o.lines.filter(l => !isNonProductLine(l))
    const allPg = !!pg && productLines.length > 0 && productLines.every(l => l.resolvedSupplierId === pg.id)
    const missingApiSku = allPg ? productLines.filter(l => !l.resolvedSupplierSku || !apiSkuBySku.get(l.resolvedSupplierSku)).map(l => l.resolvedSupplierSku ?? '—') : []
    const api = allPg && hasCredentials && missingApiSku.length === 0
    const apiNote = !allPg || api ? null
      : !hasCredentials ? 'Xưởng PGprints chưa có Store ID / Secret key — lưu chờ xuất CSV'
      : `SKU xưởng ${Array.from(new Set(missingApiSku)).join(', ')} chưa có "SKU API" — lưu chờ xuất CSV`
    const openTasks = o.designTasks.filter(t => t.status !== 'DONE' && t.status !== 'CANCELLED').length
    const closed = CLOSED_FINANCIAL.includes((o.financialStatus ?? '').toUpperCase()) || (o.fulfillmentStatus ?? '').toUpperCase() === 'FULFILLED'
    const handedOff = o.supplierHandoffAt
      ? {
          at: o.supplierHandoffAt.toISOString(), mode: o.supplierHandoffMode === 'API' ? 'API' as const : 'CSV' as const,
          byName: o.supplierHandoffById ? (nameById.get(o.supplierHandoffById) ?? null) : null,
        }
      : null
    const pending = !handedOff && o.pipelineStatus === 'READY_TO_PRODUCTION' && o.designReady && openTasks === 0 && !closed
    const push = pushes.get(o.id) ?? null
    out.set(o.id, {
      pending,
      blocked: pending || handedOff ? null : blockedReason(o, openTasks),
      mode: api ? 'API' : 'CSV',
      apiName: api ? PGPRINTS_NAME : null,
      apiNote,
      handedOff,
      canUndo: !!handedOff && handedOff.mode === 'CSV' && !AFTER_EXPORT.includes(o.pipelineStatus),
      push: push ? { status: push.status, supplierOrderCode: push.supplierOrderCode, externalOrderId: push.externalOrderId } : null,
    })
  }
  return out
}

export async function handoffStateFor(orderId: string): Promise<HandoffState | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: STATE_INCLUDE })
  if (!order) return null
  return (await handoffStates([order])).get(orderId) ?? null
}

function matches(card: HandoffCard, q: string): boolean {
  const haystacks = [
    card.order.orderNumber, card.order.customerName ?? '', ...card.suppliers.map(s => s.name),
    ...card.lines.flatMap(l => [l.taskKey, l.line.sku ?? '', l.line.productTitle, ...l.line.personalization.map(p => p.value)]),
  ]
  return haystacks.some(h => h.toLowerCase().includes(q))
}

async function buildCards(where: any, orderBy: any): Promise<HandoffCard[]> {
  const orders = await prisma.order.findMany({
    where, orderBy, take: MAX_CARDS,
    include: { ...STATE_INCLUDE, store: { include: { project: { select: { name: true } } } } },
  })
  if (orders.length === 0) return []
  const [states, workspaces] = await Promise.all([
    handoffStates(orders),
    Promise.all(orders.map(o => loadWorkspace(o.id))),
  ])
  const wsById = new Map(workspaces.filter((w): w is Workspace => !!w).map(w => [w.order.id, w]))
  const lineRows = await prisma.orderLine.findMany({
    where: { orderId: { in: orders.map(o => o.id) } },
    select: { id: true, orderId: true, resolvedSupplierId: true, resolvedSupplierSku: true, shopifyProductId: true, customAttributesJson: true },
  })
  const rowById = new Map(lineRows.map(l => [l.id, l]))
  const skuPairs = lineRows.filter(l => l.resolvedSupplierId && l.resolvedSupplierSku)
  const products = skuPairs.length
    ? await prisma.supplierProduct.findMany({
        where: { supplierId: { in: Array.from(new Set(skuPairs.map(l => l.resolvedSupplierId as string))) }, sku: { in: Array.from(new Set(skuPairs.map(l => l.resolvedSupplierSku as string))) } },
        select: { supplierId: true, sku: true, apiSku: true },
      })
    : []
  const apiSkuByKey = new Map(products.map(p => [`${p.supplierId}::${p.sku}`, p.apiSku?.trim() || null]))

  const cards: HandoffCard[] = []
  for (const o of orders) {
    const ws = wsById.get(o.id)
    const state = states.get(o.id)
    if (!ws || !state) continue
    const lines: HandoffLine[] = []
    for (const line of ws.lines) {
      if (line.isNonProduct || !line.supplier) continue
      const row = rowById.get(line.id)
      lines.push({
        line,
        slots: row ? requiredSlotsFor(row, await templateForLine(row)) : line.printAreas,
        taskKey: taskKeyFor(o.shopifyOrderNumber, line.linePosition),
        apiSku: line.supplierSku ? (apiSkuByKey.get(`${line.supplier.id}::${line.supplierSku}`) ?? null) : null,
      })
    }
    const suppliers = Array.from(new Map(lines.map(l => [l.line.supplier!.id, { id: l.line.supplier!.id, name: l.line.supplier!.name, code: l.line.supplier!.code }])).values())
    const countryCode = countryCodeOf(o.shippingCountry)
    cards.push({
      order: {
        id: o.id, orderNumber: o.shopifyOrderNumber, placedAt: o.placedAt.toISOString(), storeName: o.store.project?.name ?? o.store.shop,
        pipelineStatus: o.pipelineStatus, customerName: o.shippingName ?? o.customerName,
        country: o.shippingCountry, countryCode, countryName: countryCode ? countryNameOf(countryCode) : null,
        shipTo: [o.shippingCity, o.shippingStateCode ?? o.shippingState].filter(Boolean).join(', ') || null,
      },
      suppliers, lines, state,
    })
  }
  return cards
}

export async function listHandoffCards(f: { q?: string } = {}): Promise<{ pending: HandoffCard[]; saved: HandoffCard[] }> {
  const [pending, saved] = await Promise.all([
    buildCards(pendingHandoffWhere(), { placedAt: 'asc' }),
    buildCards(savedForCsvWhere(), { supplierHandoffAt: 'desc' }),
  ])
  const q = f.q?.trim().toLowerCase()
  return q ? { pending: pending.filter(c => matches(c, q)), saved: saved.filter(c => matches(c, q)) } : { pending, saved }
}

/** Saves "design handed over, waiting for the CSV export". Nothing else moves: the order stays READY_TO_PRODUCTION for the export page. */
export async function handoffOrderCsv(orderId: string, userId: string | null): Promise<HandoffState> {
  const state = await handoffStateFor(orderId)
  if (!state) throw new HandoffError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (state.handedOff) throw new HandoffError(state.handedOff.mode === 'API' ? 'Đơn đã chuyển supplier qua API' : 'Đơn đã lưu chờ xuất CSV', 409, 'ALREADY_HANDED_OFF')
  if (state.push) {
    throw new HandoffError(`Đơn đã có lần gửi PGprints đang hiệu lực (${state.push.supplierOrderCode ?? state.push.externalOrderId}) — không lưu chờ xuất CSV`, 409, 'ACTIVE_PUSH')
  }
  if (!state.pending) throw new HandoffError(state.blocked ?? 'Đơn chưa đủ điều kiện chuyển xưởng', 409, 'NOT_READY')
  const r = await prisma.order.updateMany({
    where: { id: orderId, ...pendingHandoffWhere() },
    data: { supplierHandoffAt: new Date(), supplierHandoffMode: 'CSV', supplierHandoffById: userId },
  })
  if (r.count !== 1) throw new HandoffError('Đơn vừa đổi trạng thái — tải lại rồi thử lại', 409, 'CHANGED')
  await logHandoffEvent(orderId, 'Chuyển supplier — lưu chờ xuất CSV', userId)
  return (await handoffStateFor(orderId))!
}

export async function undoCsvHandoff(orderId: string, userId: string | null): Promise<HandoffState> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { pipelineStatus: true, supplierHandoffAt: true, supplierHandoffMode: true } })
  if (!order) throw new HandoffError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (!order.supplierHandoffAt) throw new HandoffError('Đơn chưa được chuyển supplier', 409, 'NOT_HANDED_OFF')
  if (order.supplierHandoffMode !== 'CSV') throw new HandoffError('Đơn đã chuyển qua API — huỷ bên PGprints trong cửa sổ "Gửi PGprints"', 409, 'NOT_CSV')
  if (AFTER_EXPORT.includes(order.pipelineStatus)) throw new HandoffError('Đơn đã Exported — không hoàn tác được', 409, 'EXPORTED')
  const r = await prisma.order.updateMany({
    where: { id: orderId, supplierHandoffMode: 'CSV', supplierHandoffAt: { not: null }, pipelineStatus: { notIn: AFTER_EXPORT } },
    data: { supplierHandoffAt: null, supplierHandoffMode: null, supplierHandoffById: null },
  })
  if (r.count !== 1) throw new HandoffError('Đơn vừa đổi trạng thái — tải lại rồi thử lại', 409, 'CHANGED')
  await logHandoffEvent(orderId, 'Hoàn tác chuyển supplier (chưa xuất CSV)', userId)
  return (await handoffStateFor(orderId))!
}
