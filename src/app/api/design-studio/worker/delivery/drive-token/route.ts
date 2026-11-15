import { NextRequest, NextResponse } from 'next/server'
import { requireDeliveryWorker } from '@/lib/delivery/guard'
import { DriveAuthError, getAccessTokenInfo, isDriveConnected } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

const notConnected = () =>
  NextResponse.json({ error: 'Google Drive chưa kết nối', code: 'drive_not_connected' }, { status: 503 })

export async function POST(req: NextRequest) {
  const denied = await requireDeliveryWorker(req)
  if (denied) return denied

  if (!(await isDriveConnected())) return notConnected()
  try {
    return NextResponse.json(await getAccessTokenInfo())
  } catch (e) {
    if (e instanceof DriveAuthError) return notConnected()
    throw e
  }
}
