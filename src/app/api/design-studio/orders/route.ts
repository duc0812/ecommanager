import { NextRequest, NextResponse } from 'next/server'
import { listOrdersWithLines, type OrderFilter } from '@/lib/repos/orders'
import { isValidPipelineStatus } from '@/lib/pipeline-status'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const statuses = Array.from(new Set((sp.get('statuses') ?? '').split(',').map(s => s.trim()).filter(Boolean)))
  const invalid = statuses.filter(s => !isValidPipelineStatus(s))
  if (invalid.length > 0) return NextResponse.json({ error: `Unknown status: ${invalid.join(', ')}` }, { status: 400 })
  const dateFrom = sp.get('dateFrom')
  if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) return NextResponse.json({ error: 'dateFrom must be YYYY-MM-DD' }, { status: 400 })
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get('limit')) || DEFAULT_LIMIT))

  const base: OrderFilter = {
    projectId: sp.get('projectId') || undefined,
    supplierId: sp.get('supplierId') || undefined,
    search: sp.get('search')?.trim() || undefined,
    dateFrom: dateFrom ? new Date(dateFrom + 'T00:00:00Z') : undefined,
    limit,
  }
  const pages = await Promise.all(
    (statuses.length > 0 ? statuses : [undefined]).map(pipelineStatus => listOrdersWithLines({ ...base, pipelineStatus })),
  )
  const orders = pages.flat()
    .sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())
    .slice(0, limit)
    .map(o => ({
      id: o.id,
      shopifyOrderNumber: o.shopifyOrderNumber,
      placedAt: o.placedAt.toISOString(),
      pipelineStatus: o.pipelineStatus,
      orderType: o.orderType,
      designReady: o.designReady,
      projectId: o.projectId,
      lines: o.lines.map(l => ({
        id: l.id,
        shopifyLineId: l.shopifyLineId,
        sku: l.sku,
        productTitle: l.productTitle,
        previewCdnUrl: l.previewCdnUrl,
        resolvedSupplierId: l.resolvedSupplierId,
        customized: l.customized,
        designDriveLink: l.designDriveLink,
      })),
    }))
  return NextResponse.json({ orders })
}
