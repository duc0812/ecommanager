import { NextRequest, NextResponse } from 'next/server'
import { assignOutsource, assertOutsourceManager, outsourceManagement, revokeOutsource, OutsourceError } from '@/lib/design-outsource'
import { outsourceRoute } from '@/lib/design-outsource-route'

export const dynamic = 'force-dynamic'
export function GET(req: NextRequest) {
  return outsourceRoute(req, async user => {
    assertOutsourceManager(user)
    return NextResponse.json(await outsourceManagement(req.nextUrl.searchParams.get('taskKey') ?? '', user))
  })
}

export function POST(req: NextRequest) {
  return outsourceRoute(req, async user => {
    assertOutsourceManager(user)
    const body = await req.json().catch(() => null)
    if (!body || typeof body.taskKey !== 'string') throw new OutsourceError('Thiếu task')
    if (body.action === 'revoke') return NextResponse.json(await revokeOutsource(body.taskKey, user, body.revision))
    if (!['assign', 'refresh'].includes(body.action)) throw new OutsourceError('Thao tác không hợp lệ')
    return NextResponse.json(await assignOutsource(body.taskKey, user, body))
  })
}
