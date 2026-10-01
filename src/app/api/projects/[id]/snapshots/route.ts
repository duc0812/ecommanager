import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { previousMonth, monthlyProfit, effectiveExpectedCashflow } from '@/lib/cashflow-snapshot'
import { requireSuperadmin } from '@/lib/api-auth'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const project = await prisma.project.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  const snapshots = await prisma.cashflowSnapshot.findMany({
    where: { projectId: params.id },
    orderBy: { periodMonth: 'asc' },
  })
  const byMonth = new Map(snapshots.map(s => [s.periodMonth, s]))
  const rows = snapshots.map(s => {
    const prev = byMonth.get(previousMonth(s.periodMonth)) ?? null
    const expected = effectiveExpectedCashflow(s)
    return {
      ...s,
      closeDate: s.asOfDate,
      expectedCashflowEffective: expected,
      actualProfit: monthlyProfit(s.actualCashflow, prev ? prev.actualCashflow : null),
      expectedProfit: monthlyProfit(expected, prev ? effectiveExpectedCashflow(prev) : null),
    }
  }).reverse()
  return NextResponse.json({ rows })
}

// Corrects one month's expected figure by hand. Months that closed before the tool recorded a
// Shopify balance compute too low, and there is no history to recover it from.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const periodMonth = typeof body.periodMonth === 'string' ? body.periodMonth.trim() : ''
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) {
    return NextResponse.json({ error: 'periodMonth must be YYYY-MM' }, { status: 400 })
  }

  const raw = body.expectedCashflowManual
  let value: number | null = null
  if (raw !== null && raw !== undefined && raw !== '') {
    value = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''))
    if (!Number.isFinite(value)) return NextResponse.json({ error: 'expectedCashflowManual must be a number' }, { status: 400 })
    value = Math.round(value * 100) / 100
  }

  const snapshot = await prisma.cashflowSnapshot.findUnique({
    where: { projectId_periodMonth: { projectId: params.id, periodMonth } },
    select: { id: true },
  })
  if (!snapshot) return NextResponse.json({ error: `Chưa có snapshot cho ${periodMonth}` }, { status: 404 })

  const updated = await prisma.cashflowSnapshot.update({
    where: { id: snapshot.id },
    data: { expectedCashflowManual: value },
    select: { periodMonth: true, expectedCashflow: true, expectedCashflowManual: true },
  })
  return NextResponse.json({ ok: true, snapshot: updated })
}
