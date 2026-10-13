import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { getDriveHealth } from '@/lib/drive-health'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const health = await getDriveHealth()
  return NextResponse.json({
    ...health,
    canConnect: user.role === 'SUPERADMIN',
    canPush: user.role === 'SUPERADMIN' || user.role === 'ADMIN',
  })
}
