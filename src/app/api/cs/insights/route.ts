import { NextRequest, NextResponse } from 'next/server'
import { insights, insightsCsv, parsePeriod } from '@/lib/cs/insights'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const period = parsePeriod(p)
  const stage = p.get('stage') || undefined
  const category = p.get('category') || undefined
  const result = await insights({ ...period, stage, category })
  if (p.get('format') === 'csv') {
    return new NextResponse(insightsCsv(result.rows), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cs-insights-${period.from.toISOString().slice(0, 10)}-${period.to.toISOString().slice(0, 10)}.csv"` },
    })
  }
  return NextResponse.json({ period, ...result })
}
