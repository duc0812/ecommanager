import { NextRequest, NextResponse } from 'next/server'
import { plSummary } from '@/lib/repos/reports'
import { requireScope } from '@/lib/order-scope'

export async function GET(req: NextRequest) {
  const scope = await requireScope(req, 'fulfillment_orders')
  if ('error' in scope) return scope.error
  const { searchParams } = new URL(req.url)
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const supplierId = searchParams.get('supplierId') ?? undefined
  const projectId = searchParams.get('projectId') ?? undefined
  const pipelineStatus = searchParams.get('pipelineStatus') ?? undefined
  const search = searchParams.get('search') ?? undefined

  const summary = await plSummary({
    projectId,
    storeIds: scope.storeIds,
    supplierId,
    pipelineStatus,
    search,
    dateFrom: dateFrom ? new Date(dateFrom + 'T00:00:00Z') : undefined,
    dateTo: dateTo ? new Date(dateTo + 'T23:59:59.999Z') : undefined,
  })

  return NextResponse.json(summary)
}
