import { prisma } from '@/lib/db'
import { loadReadyDesignEntries } from './design-library'
import { matchDesignEntry } from '@/lib/design-parent'
import { resolveOrderDesignByParent, type DesignLineInputV2 } from '@/lib/design-library'
import { lineFamily, reduceOrderType } from '@/lib/order-classify'
import { hasUnresolvedProductLine, isNonProductLine } from '@/lib/order-lines'
import { autoDetectStatus, isValidPipelineStatus, type PipelineStatus } from '@/lib/pipeline-status'

type DesignEntryRef = { sku: string; supplierId: string; matchMode: string }

// Lines ordered inside the order query are loaded by a second query binding one parameter per parent order, which
// Prisma cannot split: past SQLite's 999 bind values it throws (measured: 997 parents work, 998 throw; see
// SHIPMENT_SYNC_PAGE_SIZE in shipments.ts). The lines are read for chunks of orders well under that, as listOrdersWithLines does.
const ORDER_LINES_CHUNK = 500

/** The open orders with a line of the entry's supplier that the entry matches, each with every line in line order. */
export async function loadOrdersForDesignEntry(entry: DesignEntryRef) {
  const isParent = (entry.matchMode ?? 'VARIANT').toUpperCase() === 'PARENT'
  const lineWhere: any = isParent
    ? { resolvedSupplierId: entry.supplierId, sku: { startsWith: entry.sku } }
    : { resolvedSupplierId: entry.supplierId, sku: entry.sku }

  const orders = await prisma.order.findMany({
    where: {
      pipelineStatus: { notIn: ['CANCELLED', 'REFUNDED'] },
      lines: { some: lineWhere },
    },
    select: { id: true, financialStatus: true, fulfillmentStatus: true, pipelineStatus: true },
  })
  const linesOf = new Map<string, Array<Omit<Awaited<ReturnType<typeof linesOfOrders>>[number], 'orderId'>>>()
  for (let i = 0; i < orders.length; i += ORDER_LINES_CHUNK) {
    for (const { orderId, ...line } of await linesOfOrders(orders.slice(i, i + ORDER_LINES_CHUNK).map(o => o.id))) {
      const list = linesOf.get(orderId)
      if (list) list.push(line)
      else linesOf.set(orderId, [line])
    }
  }
  return orders.map(o => ({ ...o, lines: linesOf.get(o.id) ?? [] }))
}

function linesOfOrders(orderIds: string[]) {
  return prisma.orderLine.findMany({
    where: { orderId: { in: orderIds } },
    orderBy: { linePosition: 'asc' },
    select: {
      orderId: true, id: true, sku: true, resolvedSupplierId: true, resolvedSupplierSku: true, productTitle: true,
      shopifyProductType: true, previewCdnUrl: true, designDriveLink: true, customized: true,
    },
  })
}

// Re-evaluate existing orders against the CURRENT design library (no Shopify fetch).
// Called after a design-library entry is saved so orders that use it reflect the change
// immediately: fills newly-resolved line design links, re-derives orderType / designReady /
// pipelineStatus. Supplier-scoped and mode-aware (VARIANT exact, PARENT prefix), so only
// orders whose line resolves to the SAME supplier and matches the entry are touched.
// `customized` is read from the persisted `OrderLine.customized` flag (set at Shopify sync
// time from print-files / preview / external custom fields), so re-eval never regresses a
// customized order back to non-custom.
export async function reevaluateOrdersForDesignEntry(entry: DesignEntryRef): Promise<number> {
  const orders = await loadOrdersForDesignEntry(entry)
  if (orders.length === 0) return 0

  const designEntries = await loadReadyDesignEntries()
  let updated = 0

  for (const o of orders) {
    const designInputs: DesignLineInputV2[] = o.lines.map((l, idx) => ({
      index: idx,
      sku: l.sku,
      isNonProduct: isNonProductLine({ sku: l.sku, productTitle: l.productTitle, shopifyProductType: l.shopifyProductType }),
      requiresDesign: !!l.resolvedSupplierId,
      resolvedSupplierId: l.resolvedSupplierId,
      supplierSku: l.resolvedSupplierSku,
      existingDesignLink: l.designDriveLink,
      customized: l.customized,
    }))

    const res = resolveOrderDesignByParent(designInputs, designEntries)

    // Persist newly resolved line links (lines with an existing link are left untouched).
    for (const ll of res.lineLinks) {
      const line = o.lines[ll.index]
      if (line && line.designDriveLink !== ll.designLink) {
        await prisma.orderLine.update({ where: { id: line.id }, data: { designDriveLink: ll.designLink } })
      }
    }

    const designReady = res.orderDesignReady
    const orderType = reduceOrderType(
      designInputs
        .filter(d => !d.isNonProduct && d.requiresDesign)
        .map(d => lineFamily({
          customized: d.customized,
          designType: matchDesignEntry(d.sku, d.resolvedSupplierId, designEntries)?.designType ?? 'NON_CUSTOM',
        })),
    )
    const hasDesignLine = designInputs.some(d => !d.isNonProduct && d.requiresDesign)
    const hasPendingMapping = hasUnresolvedProductLine(o.lines)
    const currentStatus = isValidPipelineStatus(o.pipelineStatus) ? (o.pipelineStatus as PipelineStatus) : null
    const pipelineStatus = autoDetectStatus({
      financialStatus: o.financialStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      hasUnmappedSku: hasPendingMapping,
      hasPendingMapping,
      hasCustomDesignLine: hasDesignLine,
      hasDesignLine,
      hasDesignReady: designReady,
      currentStatus,
    })
    const orderDesignLink =
      res.lineLinks[0]?.designLink ?? o.lines.find(l => l.designDriveLink)?.designDriveLink ?? null

    await prisma.order.update({
      where: { id: o.id },
      data: { orderType, designReady, designDriveLink: orderDesignLink, pipelineStatus },
    })
    updated++
  }
  return updated
}
