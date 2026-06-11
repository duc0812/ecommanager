import { NextRequest, NextResponse } from 'next/server'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const dateFrom = typeof body.dateFrom === 'string' && body.dateFrom
    ? new Date(`${body.dateFrom}T00:00:00.000Z`)
    : undefined
  const dateTo = typeof body.dateTo === 'string' && body.dateTo
    ? new Date(`${body.dateTo}T23:59:59.999Z`)
    : undefined

  const result = await recalculateMissingOrderLineCosts({ dateFrom, dateTo, refreshExisting: true })
  return NextResponse.json(result)
}
