import { NextRequest, NextResponse } from 'next/server'
import { crawlShipmentStatuses, type CrawlScope } from '@/lib/tracking/crawl-shipments'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const scopeParam = req.nextUrl.searchParams.get('scope')
  const scope: CrawlScope = scopeParam === 'all' ? 'all' : 'undelivered'
  try {
    const result = await crawlShipmentStatuses(scope)
    return NextResponse.json(result)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'crawl failed' }, { status: 500 })
  }
}
