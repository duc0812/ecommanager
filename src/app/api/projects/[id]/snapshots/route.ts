import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { previousMonth, monthlyProfit } from '@/lib/cashflow-snapshot'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const snapshots = await prisma.cashflowSnapshot.findMany({
    where: { projectId: params.id },
    orderBy: { periodMonth: 'asc' },
  })
  const byMonth = new Map(snapshots.map(s => [s.periodMonth, s]))
  const rows = snapshots.map(s => {
    const prev = byMonth.get(previousMonth(s.periodMonth)) ?? null
    return {
      ...s,
      actualProfit: monthlyProfit(s.actualCashflow, prev ? prev.actualCashflow : null),
      projectedProfit: monthlyProfit(s.projectedCashflow, prev ? prev.projectedCashflow : null),
    }
  }).reverse()
  return NextResponse.json({ rows })
}
