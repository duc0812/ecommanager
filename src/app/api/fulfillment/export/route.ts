import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getTemplateById, parseTemplateColumns } from '@/lib/repos/templates'
import { listOrdersWithLines, markOrdersExported } from '@/lib/repos/orders'
import { renderCsv, type CsvTemplate as RenderTemplate } from '@/lib/csv-template'
import { isNonProductLine, lineKeysOf } from '@/lib/order-lines'
import { buildOrdersForCsv } from '@/lib/export-orders'
import { enabledChannelFor, getSheetChannels } from '@/lib/sheet-channel'
import { exportLinkErrorMessage } from '@/lib/export-design-links'
import { exportProgress, exportProgressLabel, isLineExported, isOrderClosed, mixedSupplierNote } from '@/lib/line-export'
import { isMerchizeSupplier } from '@/lib/merchize'
import { CSV_LOCKED_MESSAGE, isCsvLocked } from '@/lib/csv-lock'

/** Lets the export page say so up front. */
export async function GET() {
  return NextResponse.json({ locked: await isCsvLocked(), message: CSV_LOCKED_MESSAGE })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !body.templateId) {
    return NextResponse.json({ error: 'templateId required' }, { status: 400 })
  }

  const tmpl = await getTemplateById(body.templateId)
  if (!tmpl) return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  // Owner 11/04/2026: Merchize orders are managed by API only; a CSV here would mark lines Merchize never received.
  if (isMerchizeSupplier(tmpl.supplier)) {
    return NextResponse.json({ error: 'Merchize không còn xuất CSV — gửi đơn qua API ở Duyệt sản xuất', code: 'MERCHIZE_API_ONLY' }, { status: 409 })
  }
  // Two routes to one supplier make duplicate orders: with its sheet channel on, the hub is the only way in.
  if (enabledChannelFor(await getSheetChannels(), tmpl.supplier)) {
    return NextResponse.json({ error: `${tmpl.supplier.name} đang ghi đơn thẳng vào sheet — gửi ở Duyệt sản xuất, không xuất CSV`, code: 'SHEET_ONLY' }, { status: 409 })
  }
  if (await isCsvLocked()) return NextResponse.json({ error: CSV_LOCKED_MESSAGE, code: 'CSV_LOCKED' }, { status: 409 })

  const reExport = body.reExport === true
  // Every order with a line of this supplier, also when another supplier holds most of it (defaultSupplierId).
  const matched = await listOrdersWithLines({
    projectId: body.projectId || undefined,
    lineSupplierId: tmpl.supplierId,
    pipelineStatus: body.pipelineStatus || undefined,
    dateFrom: body.dateFrom ? new Date(body.dateFrom + 'T00:00:00Z') : undefined,
    dateTo: body.dateTo ? new Date(body.dateTo + 'T23:59:59.999Z') : undefined,
    limit: 5000,
  })
  const handedOff = body.handoffOnly === true ? matched.filter(o => o.supplierHandoffAt != null) : matched

  const supplierLinesOf = (o: (typeof matched)[number]) => o.lines.filter(l =>
    !isNonProductLine(l) &&
    l.resolvedSupplierId === tmpl.supplierId &&
    Boolean(l.resolvedSupplierSku)
  )
  const openTasks = await prisma.designTask.findMany({
    where: { status: { notIn: ['DONE', 'CANCELLED'] }, order: { lines: { some: { resolvedSupplierId: tmpl.supplierId } } } },
    select: { orderId: true, shopifyLineId: true },
  })
  const inDesign = new Set(openTasks.map(t => `${t.orderId}\u0000${t.shopifyLineId}`))
  const isInDesign = (l: { orderId: string; shopifyLineId: string }) => inDesign.has(`${l.orderId}\u0000${l.shopifyLineId}`)
  // Lines already sent to a supplier stay out of the file unless the operator asks to send them again.
  // A line still in design, or an order already closed, never goes: its siblings do not wait for it.
  const includedIds = new Set<string>()
  let skippedExportedLines = 0
  let skippedNotReadyLines = 0
  for (const o of handedOff) {
    for (const l of supplierLinesOf(o)) {
      if (isInDesign(l) || (!reExport && isOrderClosed(o))) skippedNotReadyLines++
      else if (!reExport && isLineExported(o, l)) skippedExportedLines++
      else includedIds.add(l.id)
    }
  }
  const orders = handedOff.filter(o => o.lines.some(l => includedIds.has(l.id)))

  const exportableLinesOf = (o: (typeof orders)[number]) => supplierLinesOf(o).filter(l => includedIds.has(l.id))
  const templateColumns = parseTemplateColumns(tmpl.columns)
  const perOrder = tmpl.rowMode === 'PER_ORDER'
  const built = await buildOrdersForCsv({ orders, supplierId: tmpl.supplierId, columns: templateColumns, perOrder, linesOf: exportableLinesOf })
  if (built.problems.length > 0) {
    return NextResponse.json({
      error: exportLinkErrorMessage(built.problems),
      orders: Array.from(new Set(built.problems.map(p => p.orderNumber))),
      problems: built.problems,
    }, { status: 400 })
  }
  const ordersForCsv = built.ordersForCsv

  const renderTmpl: RenderTemplate = {
    rowMode: perOrder ? 'PER_ORDER' : 'PER_LINE',
    columns: templateColumns,
  }
  const csv = renderCsv(renderTmpl, ordersForCsv)

  const inCsv = new Set(ordersForCsv.map(o => o.shopifyOrderNumber))
  const csvOrders = orders.filter(o => inCsv.has(o.shopifyOrderNumber))

  let marked = { count: 0, lines: 0, completed: [] as string[] }
  if (body.markExported && csvOrders.length > 0) {
    const lineIds = csvOrders.flatMap(o => exportableLinesOf(o).map(l => l.id))
    marked = await markOrdersExported(csvOrders.map(o => o.id), tmpl.supplierId, new Date(), undefined, { lineIds })
  }

  if (body.preview) {
    const otherIds = Array.from(new Set(csvOrders.flatMap(o => o.lines.map(l => l.resolvedSupplierId).filter((x): x is string => !!x && x !== tmpl.supplierId))))
    const others = otherIds.length ? await prisma.supplier.findMany({ where: { id: { in: otherIds } }, select: { id: true, name: true } }) : []
    const nameById = new Map([[tmpl.supplierId, tmpl.supplier.name], ...others.map(s => [s.id, s.name] as [string, string])])
    const nameOf = (id: string) => nameById.get(id) ?? 'xưởng không rõ'
    const previewOrders = csvOrders.map(o => {
      const lineKeys = lineKeysOf(o.shopifyOrderNumber, o.lines)
      const progress = exportProgress(o)
      return {
        shopifyOrderNumber: o.shopifyOrderNumber,
        pipelineStatus: o.pipelineStatus,
        designHandedOff: o.supplierHandoffAt != null,
        handoffMode: o.supplierHandoffMode,
        lines: supplierLinesOf(o).map(l => ({
          linePosition: l.linePosition,
          lineKey: lineKeys.get(l.shopifyLineId) ?? '',
          productTitle: l.productTitle,
          variantTitle: l.variantTitle,
          included: includedIds.has(l.id),
          alreadyExported: isLineExported(o, l),
          inDesign: isInDesign(l),
        })),
        mixedNote: mixedSupplierNote(o, nameOf),
        exportProgress: progress.partial ? exportProgressLabel(progress) : null,
      }
    })
    return NextResponse.json({
      orderCount: ordersForCsv.length,
      csv,
      supplierCode: tmpl.supplier.code,
      supplierName: tmpl.supplier.name,
      orders: previewOrders,
      handoffCount: previewOrders.filter(o => o.designHandedOff).length,
      reExport,
      skippedExportedLines,
      skippedNotReadyLines,
    })
  }

  const dateRange = `${body.dateFrom ?? 'all'}_to_${body.dateTo ?? 'all'}`
  const filename = `${tmpl.supplier.code}_${dateRange}.csv`
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Export-Lines-Marked': String(marked.lines),
      'X-Export-Orders-Completed': String(marked.completed.length),
      'X-Export-Orders-Partial': String(Math.max(0, marked.count - marked.completed.length)),
    },
  })
}
