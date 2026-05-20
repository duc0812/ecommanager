import { NextResponse } from 'next/server'
import { syncMetaInsights } from '@/lib/sync-meta-insights'

export async function POST() {
  try {
    const result = await syncMetaInsights()
    return NextResponse.json({ success: true, ...result })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
