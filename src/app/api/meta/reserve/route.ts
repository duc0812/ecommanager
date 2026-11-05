import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { forbidden, requireSuperadmin } from '@/lib/api-auth'
import { normalizeMetaCurrency } from '@/lib/meta-currency'
import { WATCH_DAYS } from '@/lib/meta-reserve'
import { buildReserveOverview } from '@/lib/meta-reserve-service'
import { refreshReserveData, type ReserveRefreshResult } from '@/lib/meta-reserve-sync'
import { projectRowsWhere, requireFinanceScope } from '@/lib/finance-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function parseHorizon(value: string | null) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 30) return WATCH_DAYS
  return Math.round(parsed)
}

export async function GET(request: NextRequest) {
  const scope = await requireFinanceScope(request, 'meta_billing')
  if ('error' in scope) return scope.error
  try {
    const horizonDays = parseHorizon(request.nextUrl.searchParams.get('horizon'))
    return NextResponse.json(await buildReserveOverview({ horizonDays, accountWhere: projectRowsWhere(scope) }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Không thể tính dự phòng Meta billing.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const scope = await requireFinanceScope(request, 'meta_billing')
  if ('error' in scope) return scope.error
  try {
    const body = await request.json().catch(() => ({}))
    const accountId = typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId.trim() : null
    const horizonDays = parseHorizon(request.nextUrl.searchParams.get('horizon'))
    let refresh: ReserveRefreshResult
    if (!scope.projectIds) {
      refresh = await refreshReserveData(accountId)
    } else {
      // A seller refreshes the accounts it may see, one at a time (the Meta API is rate limited).
      const visible = await prisma.metaAdAccount.findMany({ where: projectRowsWhere(scope), select: { id: true }, orderBy: { createdAt: 'asc' } })
      if (accountId && !visible.some(a => a.id === accountId)) return forbidden('Bạn không có quyền với ad account này.')
      refresh = { refreshed: [], errors: [] }
      for (const account of visible.filter(a => !accountId || a.id === accountId)) {
        const part = await refreshReserveData(account.id)
        refresh.refreshed.push(...part.refreshed)
        refresh.errors.push(...part.errors)
      }
    }
    const overview = await buildReserveOverview({ horizonDays, accountWhere: projectRowsWhere(scope) })
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
