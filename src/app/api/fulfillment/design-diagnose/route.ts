import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getTrelloConfig, getCardsByList } from '@/lib/trello'
import { findDriveAttachmentForLine } from '@/lib/order-line-assets'
import { isNonProductLine } from '@/lib/order-lines'

// DIAGNOSTIC ONLY — read-only. Explains why an order's design files are (not) matched.
// GET /api/fulfillment/design-diagnose?order=1234
export async function GET(req: NextRequest) {
  const orderParam = req.nextUrl.searchParams.get('order')?.trim()
  if (!orderParam) {
    return NextResponse.json({ error: 'pass ?order=<orderNumber>' }, { status: 400 })
  }

  const wanted = orderParam.replace(/^#/, '')
  const order = await prisma.order.findFirst({
    where: { shopifyOrderNumber: { in: [wanted, `#${wanted}`] } },
    select: {
      id: true,
      shopifyOrderNumber: true,
      orderType: true,
      designReady: true,
      designDriveLink: true,
      pipelineStatus: true,
      trelloCardId: true,
      trelloCardUrl: true,
      lines: {
        orderBy: { linePosition: 'asc' },
        select: {
          id: true,
          sku: true,
          productTitle: true,
          shopifyProductType: true,
          linePosition: true,
          resolvedSupplierId: true,
          designDriveLink: true,
        },
      },
    },
  })
  if (!order) return NextResponse.json({ error: `order ${orderParam} not found` }, { status: 404 })

  const productLines = order.lines.filter(l => !isNonProductLine(l))

  const cfg = await getTrelloConfig()
  if (!cfg) return NextResponse.json({ error: 'Trello not configured' }, { status: 400 })

  let doneCards
  try {
    doneCards = await getCardsByList(cfg, cfg.doneListId)
  } catch (e: any) {
    return NextResponse.json({ error: `Trello fetch failed: ${e.message}` }, { status: 502 })
  }

  const orderTokenLc = order.shopifyOrderNumber.replace(/^#/, '').toLowerCase()
  const card =
    doneCards.find(c => c.id === order.trelloCardId) ??
    doneCards.find(c => c.name.toLowerCase().startsWith(orderTokenLc))

  const driveAttachments = (card?.attachments ?? []).filter(a => a.url.includes('drive.google.com'))

  const lineDiag = productLines.map((line, idx) => {
    const lineNumber = idx + 1
    const token = `${orderTokenLc}_${lineNumber}`
    const skuLc = (line.sku ?? '').toLowerCase().trim()
    const matched = card
      ? findDriveAttachmentForLine(order.shopifyOrderNumber, lineNumber, line.sku, driveAttachments, productLines.length)
      : null
    const tokenHits = driveAttachments
      .filter(a => `${a.name} ${a.url}`.toLowerCase().includes(token))
      .map(a => a.name)
    const skuHits = skuLc
      ? driveAttachments.filter(a => `${a.name} ${a.url}`.toLowerCase().includes(skuLc)).map(a => a.name)
      : []
    return {
      lineNumber,
      sku: line.sku,
      productTitle: line.productTitle,
      hasSupplier: !!line.resolvedSupplierId,
      storedDesignDriveLink: line.designDriveLink,
      tokenSearched: token,
      tokenHits,
      skuSearched: skuLc || null,
      skuHits,
      matchedNow: matched ? matched.name : null,
      matchReason: matched
        ? (tokenHits.includes(matched.name) ? 'token' : skuHits.includes(matched.name) ? 'sku' : 'single-line-single-file')
        : 'NO MATCH',
    }
  })

  return NextResponse.json({
    order: {
      number: order.shopifyOrderNumber,
      orderType: order.orderType,
      pipelineStatus: order.pipelineStatus,
      designReady: order.designReady,
      orderLevelDesignDriveLink: order.designDriveLink,
      trelloCardId: order.trelloCardId,
      trelloCardUrl: order.trelloCardUrl,
      productLineCount: productLines.length,
    },
    card: card
      ? {
          id: card.id,
          name: card.name,
          matchedBy: card.id === order.trelloCardId ? 'trelloCardId' : 'name-prefix',
          driveAttachments: driveAttachments.map(a => ({ name: a.name, url: a.url })),
          totalAttachments: card.attachments?.length ?? 0,
        }
      : { note: 'NO card found in Done list by trelloCardId or by name prefix' },
    lines: lineDiag,
  })
}
