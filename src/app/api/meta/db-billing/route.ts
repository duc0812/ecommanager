import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('accountId')
  const month = searchParams.get('month')
  const monthRange = month && /^\d{4}-\d{2}$/.test(month)
    ? {
        start: `${month}-01`,
        end: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().split('T')[0],
      }
    : null

  const [accounts, projects] = await Promise.all([
    prisma.metaAdAccount.findMany({
      include: { project: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.project.findMany({
      include: {
        assignments: { include: { staff: true } },
      },
    }),
  ])

  if (accounts.length === 0) {
    return NextResponse.json({ empty: true, accounts: [] })
  }

  const paidStatuses = ['PAID', 'SETTLED', 'COMPLETED']
  const visibleStatuses = [...paidStatuses, 'PENDING']
  const billingWhere = {
    status: { in: visibleStatuses },
    ...(accountId ? { adAccountId: accountId } : {}),
    ...(monthRange ? { billingDate: { gte: monthRange.start, lte: monthRange.end } } : {}),
  }

  const billingsRaw = await prisma.metaBilling.findMany({
    where: billingWhere,
    orderBy: { billingDate: 'desc' },
    include: { adAccount: { select: { accountId: true, accountName: true, projectId: true } } },
  })
  const billings = billingsRaw.map(billing => {
    const project = projects.find(p => p.id === billing.adAccount.projectId)
    const billingTime = new Date(`${billing.billingDate}T00:00:00`).getTime()
    const effectiveProjectStart = project
      ? Math.min(project.startDate.getTime(), ...project.assignments.map(a => a.startDate.getTime()))
      : null
    const projectActive = effectiveProjectStart !== null ? billingTime >= effectiveProjectStart : false
    const staffLabels = projectActive && project
      ? project.assignments
          .filter(assignment => {
            const start = assignment.startDate.getTime()
            const end = assignment.endDate?.getTime() ?? Number.POSITIVE_INFINITY
            return billingTime >= start && billingTime <= end
          })
          .map(assignment => ({
            id: assignment.staff.id,
            name: assignment.staff.name,
            role: assignment.staff.role,
          }))
      : []

    return {
      ...billing,
      projectLabel: projectActive && project ? { id: project.id, name: project.name } : null,
      staffLabels,
    }
  })

  const paidBillings = billings.filter(b => paidStatuses.includes(b.status))
  const failedBillings = billings.filter(b => b.status === 'FAILED')
  const pendingBillings = billings.filter(b => b.status === 'PENDING')
  const totalSpent = paidBillings.reduce((s, b) => s + b.amount, 0)
  const totalPending = pendingBillings.reduce((s, b) => s + b.amount, 0)
  const lastSyncAt = accounts.reduce((latest, a) => {
    if (!a.lastSyncAt) return latest
    if (!latest) return a.lastSyncAt
    return a.lastSyncAt > latest ? a.lastSyncAt : latest
  }, null as Date | null)

  return NextResponse.json({
    accounts,
    billings,
    totalSpent,
    totalPending,
    count: billings.length,
    paidCount: paidBillings.length,
    failedCount: failedBillings.length,
    pendingCount: pendingBillings.length,
    avgSpend: paidBillings.length > 0 ? totalSpent / paidBillings.length : 0,
    lastSyncAt,
  })
}
