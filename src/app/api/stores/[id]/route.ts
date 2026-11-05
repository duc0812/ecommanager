import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { PUBLIC_STORE_SELECT, publicStoreView } from '@/lib/store-connections'
import { checkTrackingPageUrl, isIsoDate } from '@/lib/store-connect'

export const dynamic = 'force-dynamic'

const EDITABLE = ['enabled', 'trackingPageUrl', 'payoutStartDate']

// A Super Admin switches a store on or off and sets the page its customers track parcels on and the date its payouts start from.
// Nothing else about a store changes here: its prefix and project come from the connect form, its credential from a reconnect.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 })
  const keys = Object.keys(body)
  if (keys.length === 0) return NextResponse.json({ error: 'Không có gì để cập nhật' }, { status: 400 })
  if (keys.some(key => !EDITABLE.includes(key))) {
    return NextResponse.json({ error: 'Chỉ đổi được enabled, trackingPageUrl và payoutStartDate' }, { status: 400 })
  }

  const data: { enabled?: boolean; trackingPageUrl?: string | null; payoutStartDate?: string | null } = {}
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'enabled phải là true hoặc false' }, { status: 400 })
    data.enabled = body.enabled
  }
  if ('trackingPageUrl' in body) {
    const value = body.trackingPageUrl
    if (value !== null && typeof value !== 'string') return NextResponse.json({ error: 'trackingPageUrl phải là chuỗi hoặc null' }, { status: 400 })
    const url = typeof value === 'string' ? value.trim() : ''
    const problem = url ? checkTrackingPageUrl(url) : null
    if (problem) return NextResponse.json({ error: `Link trang tracking: ${problem}` }, { status: 400 })
    data.trackingPageUrl = url || null
  }
  if ('payoutStartDate' in body) {
    const value = body.payoutStartDate
    if (value !== null && typeof value !== 'string') return NextResponse.json({ error: 'payoutStartDate phải là chuỗi hoặc null' }, { status: 400 })
    const date = typeof value === 'string' ? value.trim() : ''
    if (date && !isIsoDate(date)) return NextResponse.json({ error: 'payoutStartDate phải có dạng YYYY-MM-DD' }, { status: 400 })
    data.payoutStartDate = date || null
  }

  const store = await prisma.shopifyStore.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!store) return NextResponse.json({ error: 'Không tìm thấy store' }, { status: 404 })
  const updated = await prisma.shopifyStore.update({ where: { id: store.id }, data, select: PUBLIC_STORE_SELECT })
  return NextResponse.json({ store: publicStoreView(updated, true) })
}
