import { NextRequest, NextResponse } from 'next/server'
import { listOutsource } from '@/lib/design-outsource'
import { outsourceRoute } from '@/lib/design-outsource-route'

export const dynamic = 'force-dynamic'
export function GET(req: NextRequest) {
  return outsourceRoute(req, async user => NextResponse.json(await listOutsource(user)))
}
