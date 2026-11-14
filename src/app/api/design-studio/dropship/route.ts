import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { listDropshipLines } from '@/lib/dropship'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const q = req.nextUrl.searchParams.get('q')?.trim() || undefined
  return NextResponse.json(await listDropshipLines({ q }), { headers: { 'Cache-Control': 'no-store' } })
}
