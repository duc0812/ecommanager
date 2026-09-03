import { prisma } from '@/lib/db'
import { loadReadyDesignEntries } from './design-library'
import { matchDesignEntry } from '@/lib/design-parent'
import { resolveOrderDesignByParent, type DesignLineInputV2 } from '@/lib/design-library'
import { lineFamily, reduceOrderType } from '@/lib/order-classify'
import { isNonProductLine } from '@/lib/order-lines'
import { autoDetectStatus, isValidPipelineStatus, type PipelineStatus } from '@/lib/pipeline-status'

// Re-evaluate existing orders against the CURRENT design library (no Shopify fetch).
// Called after a design-library entry is saved so orders that use it reflect the change
// immediately: fills newly-resolved line design links, re-derives orderType / designReady /
// pipelineStatus. Supplier-scoped and mode-aware (VARIANT exact, PARENT prefix), so only
// orders whose line resolves to the SAME supplier and matches the entry are touched.
// `customized` is read from the persisted `OrderLine.customized` flag (set at Shopify sync
// time from print-files / preview / external custom fields), so re-eval never regresses a
// customized order back to non-custom.
export async function reevaluateOrdersForDesignEntry(entry: {
  sku: string; supplierId: string; matchMode: string
}): Promise<number> {
  const isParent = (entry.matchMode ?? 'VARIANT').toUpperCase() === 'PARENT'
  const lineWhere: any = isParent
    ? { resolvedSupplierId: entry.supplierId, sku: { startsWith: entry.sku } }
    : { resolvedSupplierId: entry.supplierId, sku: entry.sku }

  const orders = await prisma.order.findMany({
    where: {
      pipelineStatus: { notIn: ['CANCELLED', 'REFUNDED'] },
      lines: { some: lineWhere },
    },
    select: {
      id: true, financialStatus: true, fulfillmentStatus: true, pipelineStatus: true,
      lines: {
        orderBy: { linePosition: 'asc' },
        select: {
          id: true, sku: true, resolvedSupplierId: true, productTitle: true,
          shopifyProductType: true, previewCdnUrl: true, designDriveLink: true, customized: true,
        },
      },
    },
  })
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
    const hasPendingMapping = o.lines.some(l =>
      l.sku && !isNonProductLine({ sku: l.sku, productTitle: l.productTitle, shopifyProductType: l.shopifyProductType }) && !l.resolvedSupplierId)
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
