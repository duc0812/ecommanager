import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { getGoogleConfig, isDriveConfigured } from '@/lib/google-oauth'
import { getDrivePushStatus, startBulkDrivePush } from '@/lib/drive-push-queue'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(await getDrivePushStatus())
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error

  const cfg = await getGoogleConfig()
  if (!isDriveConfigured(cfg)) return NextResponse.json({ error: 'Google Drive chưa được kết nối.' }, { status: 400 })
  if (cfg.needsReconnect) return NextResponse.json({ error: 'Google Drive cần kết nối lại trước khi đẩy file.' }, { status: 409 })

  const { started } = startBulkDrivePush()
  const status = await getDrivePushStatus()
  return NextResponse.json({ ...status, started, running: true }, { status: 202 })
}
