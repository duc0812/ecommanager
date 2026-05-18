import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'

const CATEGORIES = [
  'APP_BILLING',
  'TOOLS_BILLING',
  'SOFTWARE',
  'AGENCY',
  'CONTRACTOR',
  'PAYMENT_PROCESSING',
  'OFFICE',
  'TAX',
  'OTHER',
]

const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID', 'VOID']
const ACCOUNTING_BASES = ['ACCRUAL', 'CASH']

function value(form: FormData, key: string) {
  const item = form.get(key)
  return typeof item === 'string' ? item.trim() : ''
}

function nullable(value: string) {
  return value.length > 0 ? value : null
}

function numberValue(form: FormData, key: string) {
  const parsed = Number(value(form, key))
  return Number.isFinite(parsed) ? parsed : 0
}

function monthRange(month: string | null) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null
  return {
    start: `${month}-01`,
    end: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().split('T')[0],
  }
}

function safeFileName(name: string) {
  const ext = path.extname(name).slice(0, 16)
  const base = path.basename(name, ext).replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 80)
  return `${base || 'invoice'}-${Date.now()}${ext}`
}

async function saveDocument(file: File | null) {
  if (!file || file.size === 0) return {}
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'other-bills')
  await mkdir(uploadDir, { recursive: true })
  const fileName = safeFileName(file.name)
  const bytes = Buffer.from(await file.arrayBuffer())
  await writeFile(path.join(uploadDir, fileName), bytes)
  return {
    documentUrl: `/uploads/other-bills/${fileName}`,
    documentName: file.name,
    documentMimeType: file.type || 'application/octet-stream',
    documentSize: file.size,
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const month = monthRange(searchParams.get('month'))
  const projectId = searchParams.get('projectId')
  const category = searchParams.get('category')
  const status = searchParams.get('status')

  const where = {
    ...(month ? { recognitionDate: { gte: month.start, lte: month.end } } : {}),
    ...(projectId && projectId !== 'all' ? { projectId } : {}),
    ...(category && category !== 'all' ? { category } : {}),
    ...(status && status !== 'all' ? { paymentStatus: status } : {}),
  }

  const [bills, projects, staff] = await Promise.all([
    prisma.otherBill.findMany({
      where,
      orderBy: [{ recognitionDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        project: { select: { id: true, name: true } },
        staff: { select: { id: true, name: true, role: true } },
      },
    }),
    prisma.project.findMany({ orderBy: { name: 'asc' } }),
    prisma.staff.findMany({ orderBy: { name: 'asc' } }),
  ])

  const total = bills.reduce((sum, bill) => sum + bill.totalAmount, 0)
  const paid = bills.filter(bill => bill.paymentStatus === 'PAID').reduce((sum, bill) => sum + bill.totalAmount, 0)
  const unpaid = bills.filter(bill => bill.paymentStatus !== 'PAID' && bill.paymentStatus !== 'VOID').reduce((sum, bill) => sum + bill.totalAmount, 0)
  const byCategory = CATEGORIES.map(cat => ({
    category: cat,
    total: bills.filter(bill => bill.category === cat).reduce((sum, bill) => sum + bill.totalAmount, 0),
    count: bills.filter(bill => bill.category === cat).length,
  })).filter(row => row.count > 0)

  return NextResponse.json({
    bills,
    projects,
    staff,
    categories: CATEGORIES,
    paymentStatuses: PAYMENT_STATUSES,
    stats: { total, paid, unpaid, count: bills.length, byCategory },
  })
}

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const vendorName = value(form, 'vendorName')
  const billDate = value(form, 'billDate')
  const category = value(form, 'category')
  const expenseAccount = value(form, 'expenseAccount')
  const currency = value(form, 'currency') || 'USD'
  const subtotalAmount = numberValue(form, 'subtotalAmount')
  const taxAmount = numberValue(form, 'taxAmount')
  const explicitTotal = numberValue(form, 'totalAmount')
  const totalAmount = explicitTotal > 0 ? explicitTotal : subtotalAmount + taxAmount
  const paymentStatus = value(form, 'paymentStatus') || 'UNPAID'
  const accountingBasis = value(form, 'accountingBasis') || 'ACCRUAL'
  const recognitionDate = value(form, 'recognitionDate') || billDate

  const errors: string[] = []
  if (!vendorName) errors.push('Vendor is required')
  if (!billDate) errors.push('Invoice date is required')
  if (!recognitionDate) errors.push('Recognition date is required')
  if (!category || !CATEGORIES.includes(category)) errors.push('Valid category is required')
  if (!expenseAccount) errors.push('Expense account is required')
  if (subtotalAmount <= 0) errors.push('Subtotal must be greater than 0')
  if (taxAmount < 0) errors.push('Tax cannot be negative')
  if (totalAmount <= 0) errors.push('Total must be greater than 0')
  if (!PAYMENT_STATUSES.includes(paymentStatus)) errors.push('Valid payment status is required')
  if (!ACCOUNTING_BASES.includes(accountingBasis)) errors.push('Valid accounting basis is required')
  if (paymentStatus === 'PAID' && !value(form, 'paymentDate')) errors.push('Payment date is required for paid bills')

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 })
  }

  const file = form.get('document') instanceof File ? form.get('document') as File : null
  const document = await saveDocument(file)

  const bill = await prisma.otherBill.create({
    data: {
      vendorName,
      invoiceNumber: nullable(value(form, 'invoiceNumber')),
      billDate,
      dueDate: nullable(value(form, 'dueDate')),
      serviceStartDate: nullable(value(form, 'serviceStartDate')),
      serviceEndDate: nullable(value(form, 'serviceEndDate')),
      category,
      expenseAccount,
      description: nullable(value(form, 'description')),
      currency,
      subtotalAmount,
      taxAmount,
      totalAmount,
      paymentStatus,
      paymentDate: nullable(value(form, 'paymentDate')),
      paymentMethod: nullable(value(form, 'paymentMethod')),
      referenceNumber: nullable(value(form, 'referenceNumber')),
      projectId: nullable(value(form, 'projectId')),
      staffId: nullable(value(form, 'staffId')),
      allocationNote: nullable(value(form, 'allocationNote')),
      accountingBasis,
      recognitionDate,
      notes: nullable(value(form, 'notes')),
      ...document,
    },
  })

  return NextResponse.json({ ok: true, bill })
}
