import { NextRequest, NextResponse } from 'next/server'
import { ordersWithComputedPL } from '@/lib/repos/reports'
import { countOrders, type OrderFilter } from '@/lib/repos/orders'
import { WARNING_TYPES, type WarningType } from '@/lib/order-warnings'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const supplierId = searchParams.get('supplierId') ?? undefined
  const pipelineStatus = searchParams.get('pipelineStatus') ?? undefined
  const projectId = searchParams.get('projectId') ?? undefined
  const search = searchParams.get('search') ?? undefined
  const rawWarning = searchParams.get('warningType')
  const warningType = rawWarning && (WARNING_TYPES as string[]).includes(rawWarning) ? (rawWarning as WarningType) : undefined

  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(searchParams.get('pageSize')) || DEFAULT_PAGE_SIZE),
  )
  const page = Math.max(1, Number(searchParams.get('page')) || 1)

  const baseFilter: OrderFilter = {
    projectId,
    supplierId,
    pipelineStatus,
    warningType,
    search,
    dateFrom: dateFrom ? new Date(dateFrom + 'T00:00:00Z') : undefined,
    dateTo: dateTo ? new Date(dateTo + 'T23:59:59.999Z') : undefined,
  }

  const [total, orders] = await Promise.all([
    countOrders(baseFilter),
    ordersWithComputedPL({ ...baseFilter, page, pageSize }),
  ])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return NextResponse.json({ orders, count: orders.length, total, page, pageSize, totalPages })
}
