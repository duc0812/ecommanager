import { NextRequest, NextResponse } from 'next/server'
import { ordersWithComputedPL } from '@/lib/repos/reports'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const supplierId = searchParams.get('supplierId') ?? undefined
  const pipelineStatus = searchParams.get('pipelineStatus') ?? undefined
  const projectId = searchParams.get('projectId') ?? undefined
  const search = searchParams.get('search') ?? undefined

  const orders = await ordersWithComputedPL({
    projectId,
    supplierId,
    pipelineStatus,
    search,
    dateFrom: dateFrom ? new Date(dateFrom + 'T00:00:00Z') : undefined,
    dateTo: dateTo ? new Date(dateTo + 'T23:59:59.999Z') : undefined,
    limit: 500,
  })

  return NextResponse.json({ orders, count: orders.length })
}
