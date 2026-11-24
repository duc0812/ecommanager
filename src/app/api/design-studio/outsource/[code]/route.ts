import { NextRequest, NextResponse } from 'next/server'
import { actOutsource, loadOutsource } from '@/lib/design-outsource'
import { outsourceRoute } from '@/lib/design-outsource-route'

export const dynamic = 'force-dynamic'
type Context = { params: { code: string } }

export function GET(req: NextRequest, { params }: Context) {
  return outsourceRoute(req, async user => NextResponse.json(await loadOutsource(params.code, user)))
}

export function POST(req: NextRequest, { params }: Context) {
  return outsourceRoute(req, async user => NextResponse.json(await actOutsource(params.code, user, await req.json().catch(() => ({})))))
}
