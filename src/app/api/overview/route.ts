import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  try {
    const paidMetaStatuses = ['PAID', 'SETTLED', 'COMPLETED']
    const [payouts, metaBillings, projects, staff] = await Promise.all([
      prisma.payout.findMany({ where: { status: 'paid' } }),
      prisma.metaBilling.findMany({ where: { status: { in: paidMetaStatuses } } }),
      prisma.project.findMany({
        include: {
          assignments: {
            include: { staff: true },
          },
        },
        orderBy: { startDate: 'desc' },
      }),
      prisma.staff.findMany(),
    ])

    const totalRevenue = payouts.reduce((s, p) => s + p.amount, 0)
    const payoutCount = payouts.length

    const recentPayouts = await prisma.payout.findMany({
      where: { status: 'paid' },
      orderBy: { date: 'desc' },
      take: 5,
    })

    const totalSpend = metaBillings.reduce((s, b) => s + b.amount, 0)
    const billingCount = metaBillings.length

    const recentBillings = await prisma.metaBilling.findMany({
      where: { status: { in: paidMetaStatuses } },
      orderBy: { billingDate: 'desc' },
      take: 5,
    })

    const projectList = projects.map(p => {
      const staffCount = p.assignments.length
      const monthlyCost = p.assignments.reduce((s, a) => s + (a.staff?.monthlyCost ?? 0), 0)
      return {
        id: p.id,
        name: p.name,
        startDate: p.startDate,
        staffCount,
        monthlyCost,
      }
    })

    const totalMonthlyCost = staff.reduce((s, st) => s + st.monthlyCost, 0)

    return NextResponse.json({
      shopify: { totalRevenue, payoutCount, recentPayouts },
      meta: { totalSpend, billingCount, recentBillings },
      projects: { count: projects.length, list: projectList },
      staff: { count: staff.length, totalMonthlyCost },
      netCashflow: totalRevenue - totalSpend,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Unknown error' }, { status: 500 })
  }
}
