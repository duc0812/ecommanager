import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/lib/order-scope'
import { listReviewCards, viewerFor } from '@/lib/design-tasks'
import { getDesignSettings } from '@/lib/design-settings'

export async function GET(req: NextRequest) {
  const scope = await requireScope(req, 'design_tasks')
  if ('error' in scope) return scope.error
  const { user, storeIds } = scope
  const sp = req.nextUrl.searchParams
  const [cards, settings] = await Promise.all([
    listReviewCards({ assigneeId: sp.get('mine') === '1' ? user.id : undefined, q: sp.get('q')?.trim() || undefined, storeIds }),
    getDesignSettings(),
  ])
  return NextResponse.json({
    cards, rejectReasons: settings.rejectReasons,
    me: viewerFor(user, settings),
  })
}
