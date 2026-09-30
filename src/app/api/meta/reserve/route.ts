import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { normalizeMetaCurrency } from '@/lib/meta-currency'
import { WATCH_DAYS } from '@/lib/meta-reserve'
import { buildReserveOverview } from '@/lib/meta-reserve-service'
import { refreshReserveData } from '@/lib/meta-reserve-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function parseHorizon(value: string | null) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 30) return WATCH_DAYS
  return Math.round(parsed)
}

export async function GET(request: NextRequest) {
  try {
    const horizonDays = parseHorizon(request.nextUrl.searchParams.get('horizon'))
    return NextResponse.json(await buildReserveOverview({ horizonDays }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Không thể tính dự phòng Meta billing.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const accountId = typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId.trim() : null
    const horizonDays = parseHorizon(request.nextUrl.searchParams.get('horizon'))
    const refresh = await refreshReserveData(accountId)
    const overview = await buildReserveOverview({ horizonDays })
    return NextResponse.json({ ...overview, refresh })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Không thể làm mới dữ liệu dự phòng.'
    const status = message.includes('Không tìm thấy') ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireSuperadmin(request)
  if ('error' in auth) return auth.error

  const body = await request.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const account = await prisma.metaAdAccount.findUnique({ where: { id }, select: { id: true, currency: true } })
  if (!account) return NextResponse.json({ error: 'Không tìm thấy ad account.' }, { status: 404 })

  // Dead accounts Meta can no longer collect on: kept visible, dropped from reserve + pending Meta.
  if ('excludedFromCashflow' in body) {
    const excluded = Boolean(body.excludedFromCashflow)
    await prisma.metaAdAccount.update({ where: { id }, data: { excludedFromCashflow: excluded } })
    return NextResponse.json({ ok: true, excludedFromCashflow: excluded })
  }

  // A null/blank threshold clears the manual value so the inferred one takes over again.
  const raw = body.threshold
  if (raw === null || raw === undefined || raw === '') {
    await prisma.metaAdAccount.update({
      where: { id },
      data: { billingThreshold: null, thresholdCurrency: null, thresholdSource: null },
    })
    return NextResponse.json({ ok: true, thresholdSource: null })
  }

  const threshold = Number(raw)
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return NextResponse.json({ error: 'Ngưỡng phải là số lớn hơn 0.' }, { status: 400 })
  }

  await prisma.metaAdAccount.update({
    where: { id },
    data: {
      billingThreshold: threshold,
      thresholdCurrency: normalizeMetaCurrency(account.currency),
      thresholdSource: 'MANUAL',
    },
  })
  return NextResponse.json({ ok: true, threshold, thresholdSource: 'MANUAL' })
}
