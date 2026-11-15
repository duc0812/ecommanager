import { NextRequest, NextResponse } from 'next/server'
import { requireDeliveryWorker } from '@/lib/delivery/guard'
import { DriveAuthError, getAccessTokenInfo, isDriveConnected } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

const notConnected = () =>
  NextResponse.json({ error: 'Google Drive chưa kết nối', code: 'drive_not_connected' }, { status: 503, headers: NO_STORE })

export async function POST(req: NextRequest) {
  const denied = await requireDeliveryWorker(req)
  if (denied) return denied

  if (!(await isDriveConnected())) return notConnected()
  try {
    return NextResponse.json(await getAccessTokenInfo(), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof DriveAuthError) return notConnected()
    throw e
  }
}
