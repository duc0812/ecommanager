import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { isLeader, listReviewCards } from '@/lib/design-tasks'
import { getDesignSettings } from '@/lib/design-settings'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const sp = req.nextUrl.searchParams
  const [cards, settings] = await Promise.all([
    listReviewCards({ assigneeId: sp.get('mine') === '1' ? user.id : undefined, q: sp.get('q')?.trim() || undefined }),
    getDesignSettings(),
  ])
  return NextResponse.json({
    cards, rejectReasons: settings.rejectReasons,
    me: { id: user.id, name: user.name, role: user.role, isLeader: isLeader(user.role) },
  })
}
