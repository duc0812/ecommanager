import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth'
import { SCAN_DAILY_LIMIT, isUnlimited, vnDay } from '@/lib/spy/scan-quota'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const auth = token ? await verifyToken(token) : null
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isUnlimited(auth.role)) return NextResponse.json({ isAdmin: true, used: 0, limit: SCAN_DAILY_LIMIT, remaining: null })
  const q = await prisma.spyScanQuota.findUnique({ where: { userId_day: { userId: auth.userId, day: vnDay() } } })
  const used = q?.count ?? 0
  return NextResponse.json({ isAdmin: false, used, limit: SCAN_DAILY_LIMIT, remaining: Math.max(0, SCAN_DAILY_LIMIT - used) })
}
