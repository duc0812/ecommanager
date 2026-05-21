import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { calcAmountUsd } from '@/lib/currency'

const CATEGORIES = ['APP_TOOL', 'SUBSCRIPTION', 'OFFICE', 'OTHER'] as const
const PAYMENT_METHODS = ['CK', 'PINGPONG', 'PO', 'OTHER'] as const
const CURRENCIES = ['USD', 'VND'] as const

function monthRange(month: string | null) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null
  const [y, m] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getDate()
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const month = monthRange(searchParams.get('month'))
  const projectId = searchParams.get('projectId')
  const category = searchParams.get('category')
  const paymentMethod = searchParams.get('paymentMethod')

  const where = {
    ...(month ? { paidAt: { gte: month.start, lte: month.end } } : {}),
    ...(projectId && projectId !== 'all' ? { projectId } : {}),
    ...(category && category !== 'all' ? { category } : {}),
    ...(paymentMethod && paymentMethod !== 'all' ? { paymentMethod } : {}),
  }

  const [bills, projects] = await Promise.all([
    prisma.otherBill.findMany({
      where,
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      include: { project: { select: { id: true, name: true } } },
    }),
    prisma.project.findMany({ orderBy: { name: 'asc' } }),
  ])

  const totalUsd = bills.reduce((sum, b) => sum + b.amountUsd, 0)
  const byCategory = CATEGORIES.map(cat => ({
    category: cat,
    totalUsd: bills.filter(b => b.category === cat).reduce((sum, b) => sum + b.amountUsd, 0),
    count: bills.filter(b => b.category === cat).length,
  })).filter(row => row.count > 0)

  const distinctProjects = new Set(bills.map(b => b.projectId).filter(Boolean)).size

  return NextResponse.json({
    bills,
    projects,
    stats: { totalUsd, count: bills.length, byCategory, distinctProjects },
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { vendor, category, amount, currency = 'USD', exchangeRate, paidAt, paymentMethod, transactionId, note, tags, projectId } = body

  const errors: string[] = []
  if (!vendor?.trim()) errors.push('vendor required')
  if (!CATEGORIES.includes(category)) errors.push('invalid category')
  if (!amount || Number(amount) <= 0) errors.push('amount must be > 0')
  if (!paidAt?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) errors.push('paidAt must be YYYY-MM-DD')
  if (!PAYMENT_METHODS.includes(paymentMethod)) errors.push('invalid paymentMethod')
  if (!CURRENCIES.includes(currency)) errors.push('invalid currency')
  if (currency === 'VND' && (!exchangeRate || Number(exchangeRate) <= 0)) errors.push('exchangeRate required for VND')

  if (errors.length > 0) return NextResponse.json({ error: errors.join(', ') }, { status: 400 })

  const tagsStr = (() => {
    if (!tags) return '[]'
    if (Array.isArray(tags)) return JSON.stringify(tags.map(String))
    if (typeof tags === 'string') {
      try { const parsed = JSON.parse(tags); return Array.isArray(parsed) ? tags : '[]' } catch { return '[]' }
    }
    return '[]'
  })()

  const amountUsd = calcAmountUsd({ amount: Number(amount), currency, exchangeRate: exchangeRate ? Number(exchangeRate) : undefined })

  const bill = await prisma.otherBill.create({
    data: {
      vendor: vendor.trim(),
      category,
      amount: Number(amount),
      currency,
      amountUsd,
      exchangeRate: exchangeRate ? Number(exchangeRate) : null,
      paidAt,
      paymentMethod,
      transactionId: transactionId?.trim() || null,
      note: note?.trim() || null,
      tags: tagsStr,
      projectId: projectId || null,
    },
  })

  return NextResponse.json({ ok: true, bill })
}
