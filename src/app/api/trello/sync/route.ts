import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getTrelloConfig, getCardsByList } from '@/lib/trello'
import { findDriveAttachmentForLine } from '@/lib/order-line-assets'
import { isNonProductLine } from '@/lib/order-lines'

function cardMatchesOrder(cardName: string, orderNumber: string, skus: string[]): boolean {
  const normalizedCardName = cardName.toLowerCase()
  if (!normalizedCardName.startsWith(orderNumber.toLowerCase())) return false
  const realSkus = skus.filter(Boolean)
  return realSkus.length > 0 && realSkus.some(sku => normalizedCardName.includes(sku.toLowerCase()))
}

export async function POST() {
  const cfg = await getTrelloConfig()
  if (!cfg) {
    return NextResponse.json({ error: 'Trello chưa được cấu hình. Vào Setup để nhập API key.' }, { status: 400 })
  }

  let cards
  try {
    cards = await getCardsByList(cfg, cfg.doneListId)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 })
  }

  let updated = 0

  for (const card of cards) {
    const driveAttachments = card.attachments?.filter(a => a.url.includes('drive.google.com')) ?? []
    const driveAttachment = driveAttachments[0]
    if (!driveAttachment) continue

    const linkedResult = await prisma.skuDesign.updateMany({
      where: { trelloCardId: card.id, designReady: false },
      data: { designReady: true, driveLink: driveAttachment.url },
    })
    updated += linkedResult.count

    const linkedOrders = await prisma.order.findMany({
      where: { trelloCardId: card.id },
      select: {
        id: true,
        shopifyOrderNumber: true,
        orderType: true,
        lines: { orderBy: { linePosition: 'asc' }, select: { sku: true, productTitle: true, shopifyProductType: true, linePosition: true } },
      },
    })

    const customOrdersMatchedByName = await prisma.order.findMany({
      where: {
        orderType: 'CUSTOM',
        trelloCardId: null,
        designReady: false,
      },
      select: {
        id: true,
        shopifyOrderNumber: true,
        lines: { orderBy: { linePosition: 'asc' }, select: { sku: true, productTitle: true, shopifyProductType: true, resolvedSupplierId: true } },
      },
    })
    const matchedCustomOrderIds = customOrdersMatchedByName
      .filter(o => {
        const skuLines = o.lines.filter(l => l.sku && !isNonProductLine(l))
        return skuLines.length > 0 &&
          skuLines.every(l => l.resolvedSupplierId) &&
          cardMatchesOrder(card.name, o.shopifyOrderNumber, skuLines.map(l => l.sku).filter(Boolean) as string[])
      })
      .map(o => o.id)

    const orderResult = await prisma.order.updateMany({
      where: {
        OR: [
          { trelloCardId: card.id, designReady: false },
          ...(matchedCustomOrderIds.length > 0 ? [{ id: { in: matchedCustomOrderIds } }] : []),
        ],
      },
      data: {
        trelloCardId: card.id,
        trelloCardUrl: card.url,
      },
    })
    updated += orderResult.count

    const touchedOrderIds = Array.from(new Set([
      ...linkedOrders.map(o => o.id),
      ...matchedCustomOrderIds,
    ]))
    for (const orderId of touchedOrderIds) {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          shopifyOrderNumber: true,
          pipelineStatus: true,
          lines: {
            orderBy: { linePosition: 'asc' },
            select: {
              id: true,
              sku: true,
              productTitle: true,
              shopifyProductType: true,
              resolvedSupplierId: true,
              linePosition: true,
              designDriveLink: true,
            },
          },
        },
      })
      if (!order) continue

      const productLines = order.lines.filter(l => !isNonProductLine(l))
      const nextDriveLinks = new Map<string, string>()
      for (let idx = 0; idx < productLines.length; idx += 1) {
        const line = productLines[idx]
        const attachment = findDriveAttachmentForLine(
          order.shopifyOrderNumber,
          idx + 1,
          line.sku,
          driveAttachments,
          productLines.length,
        )
        if (!attachment) continue
        nextDriveLinks.set(line.id, attachment.url)
        if (line.designDriveLink !== attachment.url) {
          await prisma.orderLine.update({
            where: { id: line.id },
            data: { designDriveLink: attachment.url },
          })
          updated++
        }
      }

      const hasSupplier = productLines.length > 0 && productLines.every(l => l.resolvedSupplierId)
      const allLinesHaveDrive = productLines.length > 0 &&
        productLines.every(l => nextDriveLinks.has(l.id) || !!l.designDriveLink)
      if (allLinesHaveDrive) {
        await prisma.order.update({
          where: { id: orderId },
          data: {
            designReady: true,
            designDriveLink: nextDriveLinks.values().next().value ?? productLines.find(l => l.designDriveLink)?.designDriveLink ?? null,
          },
        })
      }
      if (hasSupplier && allLinesHaveDrive && ['PENDING_DESIGN', 'PENDING', 'WARNING', 'PENDING_MAPPING'].includes(order.pipelineStatus)) {
        await prisma.order.update({
          where: { id: orderId },
          data: { pipelineStatus: 'READY_TO_PRODUCTION' },
        })
      }
    }

    const skus = Array.from(new Set(
      linkedOrders
        .filter(o => o.orderType !== 'CUSTOM')
        .flatMap(o => o.lines.map(l => l.sku).filter(Boolean) as string[]),
    ))

    for (const sku of skus) {
      const before = await prisma.skuDesign.findUnique({ where: { sku }, select: { designReady: true } })
      await prisma.skuDesign.upsert({
        where: { sku },
        create: {
          sku,
          trelloCardId: card.id,
          designReady: true,
          driveLink: driveAttachment.url,
        },
        update: {
          trelloCardId: card.id,
          designReady: true,
          driveLink: driveAttachment.url,
        },
      })
      if (!before?.designReady) updated++
    }
  }

  return NextResponse.json({ updated, cardsChecked: cards.length })
}
