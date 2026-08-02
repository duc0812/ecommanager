import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runAutoSync } from '@/lib/auto-sync'

export async function GET() {
  try {
    const setting = await prisma.appSetting.findUnique({
      where: { key: 'last_auto_sync_result' },
    })
    const lastResult = setting?.value ? JSON.parse(setting.value) : null
    return NextResponse.json({ status: 'idle', lastResult })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const result = await runAutoSync(req.nextUrl.origin, req.headers.get('cookie'))
    return NextResponse.json({ success: true, result })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
