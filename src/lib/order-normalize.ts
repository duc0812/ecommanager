import { prisma } from '@/lib/db'
import { fetchOrderFulfillmentsPage, type ShopifyOrderFulfillments } from '@/lib/shopify-orders'

const TERMINAL = ['FULFILLED', 'CANCELLED', 'REFUNDED']

// Pure decision: given Shopify's current order-level fulfillment status and the
// DB's stored fulfillment/pipeline status, what should we write back?
// - refresh fulfillmentStatus when Shopify has a (different) value
// - once Shopify reports FULFILLED, advance a still-active pipeline to FULFILLED
export function planStatusNormalization(
  shopifyFulfillment: string | null,
  dbFulfillment: string | null,
  dbPipeline: string,
): { fulfillmentStatus?: string; pipelineStatus?: string } {
  const out: { fulfillmentStatus?: string; pipelineStatus?: string } = {}
  if (shopifyFulfillment && shopifyFulfillment !== dbFulfillment) {
    out.fulfillmentStatus = shopifyFulfillment
  }
  if ((shopifyFulfillment ?? '').toUpperCase() === 'FULFILLED' && !TERMINAL.includes((dbPipeline ?? '').toUpperCase())) {
    out.pipelineStatus = 'FULFILLED'
  }
  return out
}

export type NormalizeResult = {
  ordersOpen: number
  since: string | null
  fulfillmentUpdated: number
  pipelineFulfilled: number
  errors: string[]
}

// Refresh fulfillment/pipeline status for ALL open orders of a store (no rolling
// window) so stale statuses — e.g. old POD orders that Shopify fulfilled weeks
// after they were placed — get normalized instead of sitting UNFULFILLED forever.
export async function normalizeOpenOrderStatuses(params: {
  shop: string
  accessToken: string
  storeId: string
}): Promise<NormalizeResult> {
  const errors: string[] = []

  // Candidates that can still change: DB not fully fulfilled AND pipeline not terminal.
  const open = await prisma.order.findMany({
    where: {
      storeId: params.storeId,
      pipelineStatus: { notIn: ['CANCELLED', 'REFUNDED'] },
      OR: [
        { fulfillmentStatus: null },
        { fulfillmentStatus: { notIn: ['FULFILLED', 'fulfilled'] } },
        { pipelineStatus: { notIn: ['FULFILLED', 'CANCELLED', 'REFUNDED'] } },
      ],
    },
    select: { id: true, placedAt: true, fulfillmentStatus: true, pipelineStatus: true },
  })

  if (open.length === 0) {
    return { ordersOpen: 0, since: null, fulfillmentUpdated: 0, pipelineFulfilled: 0, errors }
  }

  const earliest = open.reduce((min, o) => (o.placedAt < min ? o.placedAt : min), open[0].placedAt)
  // Pull one day earlier to be safe on the processed_at boundary Shopify filters on.
  const since = new Date(earliest.getTime() - 24 * 60 * 60 * 1000)
  const sinceIso = since.toISOString().split('T')[0]

  const byId = new Map<string, ShopifyOrderFulfillments>()
  let cursor: string | null = null
  do {
    let page
    try {
      page = await fetchOrderFulfillmentsPage(params.shop, params.accessToken, cursor, sinceIso)
    } catch (e: any) {
      errors.push(e?.message ?? 'fetch fulfillments failed')
      break
    }
    for (const o of page.orders) byId.set(o.id, o)
    cursor = page.hasNextPage ? page.endCursor : null
  } while (cursor)

  let fulfillmentUpdated = 0
  let pipelineFulfilled = 0
  for (const o of open) {
    const sd = byId.get(o.id)
    if (!sd) continue
    const plan = planStatusNormalization(sd.fulfillmentStatus, o.fulfillmentStatus, o.pipelineStatus)
    if (!plan.fulfillmentStatus && !plan.pipelineStatus) continue
    try {
      await prisma.order.update({ where: { id: o.id }, data: plan })
      if (plan.fulfillmentStatus) fulfillmentUpdated++
      if (plan.pipelineStatus) pipelineFulfilled++
    } catch (e: any) {
      errors.push(`update ${o.id}: ${e?.message ?? 'failed'}`)
    }
  }

  return { ordersOpen: open.length, since: sinceIso, fulfillmentUpdated, pipelineFulfilled, errors }
}
