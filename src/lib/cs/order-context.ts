import { prisma } from '@/lib/db'

export type FactoryState = 'NOT_SENT' | 'AT_FACTORY' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED'
export type OrderMatch = 'EXACT' | 'BY_EMAIL' | 'AMBIGUOUS' | 'NONE'

export type OrderContextOrder = {
  id: string
  shopifyOrderNumber: string
  placedAt: Date
  customerName: string | null
  customerEmail: string | null
  shipTo: string
  factoryState: FactoryState
  supplierHandoffAt: Date | null
  pipelineStatus: string
  lines: { title: string; variant: string | null; qty: number; customized: boolean }[]
  shipments: { trackingNumber: string | null; carrier: string | null; status: string; lastCheckpointAt: Date | null; trackingUrl: string | null }[]
  designTaskStatuses: string[]
}

export type OrderContext = { match: OrderMatch; order: OrderContextOrder | null; candidates: string[] }

const TRACKING_PAGE = 'https://litzzy.com/apps/trackingorder?nums='

export function extractOrderNumbers(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/#?\bLIT\s?(\d{3,6})\b/gi)) {
    const n = `#LIT${m[1]}`
    if (!out.includes(n)) out.push(n)
  }
  return out
}

export function factoryStateOf(o: {
  supplierHandoffAt: Date | null
  pipelineStatus: string
  fulfillmentStatus: string | null
  supplierPushes: { status: string }[]
  shipments: { status: string }[]
}): FactoryState {
  if (o.pipelineStatus === 'CANCELLED' || o.pipelineStatus === 'REFUNDED') return 'CANCELLED'
  const moving = o.shipments.filter(s => s.status !== 'PENDING')
  if (moving.length && moving.every(s => s.status === 'DELIVERED')) return 'DELIVERED'
  if (moving.length || o.pipelineStatus === 'FULFILLED' || o.fulfillmentStatus === 'FULFILLED') return 'SHIPPED'
  if (o.supplierHandoffAt || o.pipelineStatus === 'EXPORTED' || o.supplierPushes.some(p => p.status === 'SENDING' || p.status === 'CREATED')) return 'AT_FACTORY'
  return 'NOT_SENT'
}

const include = { lines: { orderBy: { linePosition: 'asc' as const } }, shipments: true, designTasks: true, supplierPushes: true }
type Loaded = NonNullable<Awaited<ReturnType<typeof loadByNumber>>>

function loadByNumber(shopifyOrderNumber: string) {
  return prisma.order.findFirst({ where: { shopifyOrderNumber }, include })
}

function toContextOrder(o: Loaded): OrderContextOrder {
  const shipTo = [o.shippingName, o.shippingAddress1, o.shippingAddress2, [o.shippingCity, o.shippingStateCode ?? o.shippingState, o.shippingZip].filter(Boolean).join(' '), o.shippingCountry]
    .filter(Boolean).join(', ')
  return {
    id: o.id,
    shopifyOrderNumber: o.shopifyOrderNumber,
    placedAt: o.placedAt,
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    shipTo,
    factoryState: factoryStateOf(o),
    supplierHandoffAt: o.supplierHandoffAt,
    pipelineStatus: o.pipelineStatus,
    lines: o.lines.map(l => ({ title: l.productTitle, variant: l.variantTitle, qty: l.qty, customized: l.customized })),
    shipments: o.shipments.map(s => ({
      trackingNumber: s.trackingNumber,
      carrier: s.lastMileCarrier ?? s.detectedCarrier ?? s.carrier,
      status: s.status,
      lastCheckpointAt: s.lastCheckpointAt,
      trackingUrl: s.trackingUrl ?? (s.trackingNumber ? `${TRACKING_PAGE}${s.trackingNumber}` : null),
    })),
    designTaskStatuses: o.designTasks.map(t => t.status),
  }
}

export async function buildOrderContext(input: { subject: string; texts: string[]; cfOrderId?: string | null; email?: string | null }): Promise<OrderContext> {
  const numbers = extractOrderNumbers([input.cfOrderId ?? '', input.subject, ...input.texts].join('\n'))
  for (const n of numbers) {
    const o = await loadByNumber(n)
    if (o) return { match: 'EXACT', order: toContextOrder(o), candidates: numbers }
  }
  const email = input.email?.trim().toLowerCase()
  if (!email) return { match: 'NONE', order: null, candidates: [] }
  const byEmail = await prisma.order.findMany({ where: { customerEmail: email }, include, orderBy: { placedAt: 'desc' }, take: 5 })
  if (byEmail.length === 1) return { match: 'BY_EMAIL', order: toContextOrder(byEmail[0]), candidates: [byEmail[0].shopifyOrderNumber] }
  if (byEmail.length > 1) return { match: 'AMBIGUOUS', order: null, candidates: byEmail.map(o => o.shopifyOrderNumber) }
  return { match: 'NONE', order: null, candidates: [] }
}
