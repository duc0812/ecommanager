import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getTrelloConfig, getCardDesc, updateCardDesc } from '@/lib/trello'
import { getShopifyConnection } from '@/lib/token-store'
import { fetchOrderLinePropsByNames, type ShopifyOrderLineProps } from '@/lib/shopify-orders'
import { buildPersonalizationSections, cardHasInlinePersonalization, mergePersonalizationIntoDesc, PERSONALIZATION_MARKER } from '@/lib/order-classify'

// Scoped by a recent time window rather than by design state: orders sitting at
// designReady = false are mostly a historical backlog going back months, and rewriting
// those cards would flood the board's activity feed for nothing.
const DEFAULT_SINCE_DAYS = 7

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any))
  const dryRun = body?.dryRun === true
  const sinceDays = Number.isFinite(body?.sinceDays)
    ? Math.min(Math.max(Math.trunc(body.sinceDays), 1), 365)
    : DEFAULT_SINCE_DAYS

  const cfg = await getTrelloConfig()
  if (!cfg) {
    return NextResponse.json({ error: 'Trello chưa được cấu hình. Vào Setup để nhập API key.' }, { status: 400 })
  }
  const conn = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
  if (!conn) {
    return NextResponse.json({ error: 'Chưa kết nối Shopify. Vào /setup để connect trước.' }, { status: 401 })
  }

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
  const orders = await prisma.order.findMany({
    where: {
      trelloCardId: { not: null },
      placedAt: { gte: since },
    },
    select: { shopifyOrderNumber: true, trelloCardId: true },
    orderBy: { placedAt: 'desc' },
  })
  if (orders.length === 0) {
    return NextResponse.json({
      dryRun, sinceDays, ordersChecked: 0, cardsChecked: 0, cardsUpdated: 0, cardsUnchanged: 0,
      alreadyComplete: 0, noPersonalization: 0, notFoundOnShopify: [], notFoundCount: 0,
      samples: [], errors: [],
    })
  }

  // Line-item properties are not stored on OrderLine, so the raw customer input has to
  // come back from Shopify.
  let propsByOrderName: Map<string, ShopifyOrderLineProps[]>
  try {
    propsByOrderName = await fetchOrderLinePropsByNames(
      conn.shop,
      conn.token,
      orders.map(o => o.shopifyOrderNumber),
    )
  } catch (e: any) {
    return NextResponse.json({ error: `Shopify: ${e.message}` }, { status: 502 })
  }

  // One card can be shared by several orders, so compose the whole block per card.
  type CardOrder = { shopifyOrderNumber: string; trelloCardId: string | null }
  const ordersByCard = new Map<string, CardOrder[]>()
  for (const o of orders) {
    const list = ordersByCard.get(o.trelloCardId!) ?? []
    list.push(o)
    ordersByCard.set(o.trelloCardId!, list)
  }

  let cardsUpdated = 0
  let cardsUnchanged = 0
  let alreadyComplete = 0
  let noPersonalization = 0
  const notFoundOnShopify: string[] = []
  const samples: string[] = []
  const errors: string[] = []

  for (const [cardId, cardOrders] of Array.from(ordersByCard.entries())) {
    const blocks: string[] = []
    for (const o of cardOrders) {
      const lines = propsByOrderName.get(o.shopifyOrderNumber)
      if (!lines) { notFoundOnShopify.push(o.shopifyOrderNumber); continue }
      const section = buildPersonalizationSections(
        o.shopifyOrderNumber,
        lines.map(l => ({
          sku: l.sku,
          productTitle: l.title,
          variantTitle: l.variantTitle,
          shopifyProductType: l.productType,
          customAttributes: l.customAttributes,
        })),
      )
      if (!section) continue
      blocks.push(cardOrders.length > 1 ? `_${o.shopifyOrderNumber}_\n\n${section}` : section)
    }
    if (blocks.length === 0) { noPersonalization += 1; continue }

    const block = `${PERSONALIZATION_MARKER}\n\n${blocks.join('\n\n')}`
    try {
      const desc = await getCardDesc(cfg, cardId)
      if (desc === null) { cardsUnchanged += 1; continue }
      // Cards created after the fix already carry the input inline — appending would duplicate it.
      if (cardHasInlinePersonalization(desc)) { alreadyComplete += 1; continue }
      const next = mergePersonalizationIntoDesc(desc, block)
      if (next === desc) { cardsUnchanged += 1; continue }
      if (!dryRun) await updateCardDesc(cfg, cardId, next)
      cardsUpdated += 1
      if (samples.length < 20) samples.push(cardOrders.map(o => o.shopifyOrderNumber).join(' + '))
    } catch (e: any) {
      errors.push(`${cardOrders[0].shopifyOrderNumber}: ${e.message}`)
    }
  }

  return NextResponse.json({
    dryRun,
    sinceDays,
    ordersChecked: orders.length,
    cardsChecked: ordersByCard.size,
    cardsUpdated,
    cardsUnchanged,
    alreadyComplete,
    noPersonalization,
    notFoundOnShopify: notFoundOnShopify.slice(0, 20),
    notFoundCount: notFoundOnShopify.length,
    samples,
    errors,
  })
}
