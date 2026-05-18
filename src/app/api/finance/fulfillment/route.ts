import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'

const COST_TYPES = ['PRODUCT_COST', 'PICK_PACK', 'SHIPPING', 'STORAGE', 'RETURNS', 'MIXED', 'ADJUSTMENT']
const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID', 'VOID']

function value(form: FormData, key: string) {
  const item = form.get(key)
  return typeof item === 'string' ? item.trim() : ''
}

function nullable(v: string) {
  return v.length > 0 ? v : null
}

function numberValue(form: FormData, key: string) {
  const parsed = Number(value(form, key))
  return Number.isFinite(parsed) ? parsed : 0
}

function intValue(form: FormData, key: string) {
  const parsed = Number.parseInt(value(form, key), 10)
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
  return `${base || 'fulfillment'}-${Date.now()}${ext}`
}

async function saveDocument(file: File | null) {
  if (!file || file.size === 0) return {}
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'fulfillment')
  await mkdir(uploadDir, { recursive: true })
  const fileName = safeFileName(file.name)
  await writeFile(path.join(uploadDir, fileName), Buffer.from(await file.arrayBuffer()))
  return {
    documentUrl: `/uploads/fulfillment/${fileName}`,
    documentName: file.name,
    documentMimeType: file.type || 'application/octet-stream',
    documentSize: file.size,
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const month = monthRange(searchParams.get('month'))
  const projectId = searchParams.get('projectId')
  const costType = searchParams.get('costType')
  const status = searchParams.get('status')

  const where = {
    ...(month ? { recognitionDate: { gte: month.start, lte: month.end } } : {}),
    ...(projectId && projectId !== 'all' ? { projectId } : {}),
    ...(costType && costType !== 'all' ? { costType } : {}),
    ...(status && status !== 'all' ? { paymentStatus: status } : {}),
  }

  const [costs, projects, staff] = await Promise.all([
    prisma.fulfillmentCost.findMany({
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

  const total = costs.reduce((sum, item) => sum + item.totalAmount, 0)
  const paid = costs.filter(item => item.paymentStatus === 'PAID').reduce((sum, item) => sum + item.totalAmount, 0)
  const payable = costs.filter(item => item.paymentStatus !== 'PAID' && item.paymentStatus !== 'VOID').reduce((sum, item) => sum + item.totalAmount, 0)
  const orderCount = costs.reduce((sum, item) => sum + item.orderCount, 0)
  const itemCount = costs.reduce((sum, item) => sum + item.itemCount, 0)

  return NextResponse.json({
    costs,
    projects,
    staff,
    costTypes: COST_TYPES,
    paymentStatuses: PAYMENT_STATUSES,
    stats: {
      total,
      paid,
      payable,
      count: costs.length,
      orderCount,
      itemCount,
      costPerOrder: orderCount > 0 ? total / orderCount : 0,
      productCost: costs.reduce((sum, item) => sum + item.productCost, 0),
      shippingCost: costs.reduce((sum, item) => sum + item.shippingCost, 0),
      pickPackCost: costs.reduce((sum, item) => sum + item.pickPackCost, 0),
    },
  })
}

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const providerName = value(form, 'providerName')
  const billDate = value(form, 'billDate')
  const recognitionDate = value(form, 'recognitionDate') || billDate
  const costType = value(form, 'costType') || 'MIXED'
  const currency = value(form, 'currency') || 'USD'
  const productCost = numberValue(form, 'productCost')
  const pickPackCost = numberValue(form, 'pickPackCost')
  const shippingCost = numberValue(form, 'shippingCost')
  const storageCost = numberValue(form, 'storageCost')
  const returnCost = numberValue(form, 'returnCost')
  const adjustmentAmount = numberValue(form, 'adjustmentAmount')
  const taxAmount = numberValue(form, 'taxAmount')
  const calculatedTotal = productCost + pickPackCost + shippingCost + storageCost + returnCost + adjustmentAmount + taxAmount
  const explicitTotal = numberValue(form, 'totalAmount')
  const totalAmount = explicitTotal > 0 ? explicitTotal : calculatedTotal
  const paymentStatus = value(form, 'paymentStatus') || 'UNPAID'

  const errors: string[] = []
  if (!providerName) errors.push('Provider is required')
  if (!billDate) errors.push('Bill date is required')
  if (!recognitionDate) errors.push('Recognition date is required')
  if (!COST_TYPES.includes(costType)) errors.push('Valid cost type is required')
  if (totalAmount <= 0) errors.push('Total fulfillment cost must be greater than 0')
  if (!PAYMENT_STATUSES.includes(paymentStatus)) errors.push('Valid payment status is required')
  if (paymentStatus === 'PAID' && !value(form, 'paymentDate')) errors.push('Payment date is required for paid costs')

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 })
  }

  const file = form.get('document') instanceof File ? form.get('document') as File : null
  const document = await saveDocument(file)

  const cost = await prisma.fulfillmentCost.create({
    data: {
      providerName,
      invoiceNumber: nullable(value(form, 'invoiceNumber')),
      billDate,
      serviceStartDate: nullable(value(form, 'serviceStartDate')),
      serviceEndDate: nullable(value(form, 'serviceEndDate')),
      recognitionDate,
      costType,
      currency,
      orderCount: intValue(form, 'orderCount'),
      itemCount: intValue(form, 'itemCount'),
      productCost,
      pickPackCost,
      shippingCost,
      storageCost,
      returnCost,
      adjustmentAmount,
      taxAmount,
      totalAmount,
      paymentStatus,
      paymentDate: nullable(value(form, 'paymentDate')),
      paymentMethod: nullable(value(form, 'paymentMethod')),
      referenceNumber: nullable(value(form, 'referenceNumber')),
      projectId: nullable(value(form, 'projectId')),
      staffId: nullable(value(form, 'staffId')),
      notes: nullable(value(form, 'notes')),
      ...document,
    },
  })

  return NextResponse.json({ ok: true, cost })
}
