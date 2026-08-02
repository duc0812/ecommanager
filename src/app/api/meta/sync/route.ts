import { NextRequest, NextResponse } from 'next/server'
import { getMetaBillingSyncJob, startMetaBillingSync } from '@/lib/meta-billing-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const job = await getMetaBillingSyncJob()
    return NextResponse.json({ job })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Không thể đọc trạng thái Meta billing sync.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const accountId = typeof body.accountId === 'string' && body.accountId.trim()
      ? body.accountId.trim()
      : null
    const result = await startMetaBillingSync(accountId)

    return NextResponse.json(
      {
        accepted: !result.alreadyRunning,
        alreadyRunning: result.alreadyRunning,
        job: result.job,
      },
      { status: result.alreadyRunning ? 200 : 202 },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Không thể bắt đầu Meta billing sync.'
    const status = message.includes('Không tìm thấy') ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
