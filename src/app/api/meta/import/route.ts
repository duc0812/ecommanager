import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { prisma } from '@/lib/db'
import { parseCsv } from '@/lib/csv-parser'

type ImportRow = Record<string, string>

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function pick(row: ImportRow, names: string[]) {
  const wanted = names.map(normalizeHeader)
  const key = Object.keys(row).find(k => wanted.includes(normalizeHeader(k)))
  return key ? String(row[key] ?? '').trim() : ''
}

function parseAmount(value: string) {
  const cleaned = value.replace(/[^0-9.-]+/g, '')
  const amount = Number(cleaned)
  return Number.isFinite(amount) ? amount : 0
}

function parseDate(value: string) {
  const raw = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) {
    const month = slash[1].padStart(2, '0')
    const day = slash[2].padStart(2, '0')
    return `${slash[3]}-${month}-${day}`
  }

  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear()
    const month = String(parsed.getMonth() + 1).padStart(2, '0')
    const day = String(parsed.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return ''
}

function parsePaymentMethod(value: string) {
  const text = value.replace(/\s+/g, ' ').trim()
  const last4 = text.match(/(?:\*+|x+|\.{2,}|[-\s])(\d{4})(?!\d)/i)?.[1] ?? null
  const code = text.match(/\b[A-Z0-9]{8,16}\b(?!.*\b[A-Z0-9]{8,16}\b)/)?.[0] ?? null
  const label = text
    .replace(/\b[A-Z0-9]{8,16}\b(?!.*\b[A-Z0-9]{8,16}\b)/, '')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    label: label || text || null,
    last4,
    code,
  }
}

function parseRows(file: File, buffer: ArrayBuffer): ImportRow[] {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const workbook = XLSX.read(buffer, { type: 'array' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    return XLSX.utils.sheet_to_json<ImportRow>(sheet, { defval: '' })
  }

  const text = Buffer.from(buffer).toString('utf8')
  return parseMetaInvoiceSummaryCsv(text) ?? parseCsv(text)
}

function parseMetaInvoiceSummaryCsv(text: string): ImportRow[] | null {
  const tableRows: ImportRow[] = []
  let paymentMethod = ''
  let sawMetaSummary = false
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()

    if (/^Meta Ads payment$/i.test(line)) {
      sawMetaSummary = true
      paymentMethod = ''
      continue
    }

    if (sawMetaSummary && /^Payment Method:/i.test(line)) {
      paymentMethod = line.replace(/^Payment Method:\s*/i, '').trim()
      continue
    }

    if (/^Date\s*,\s*Transaction ID\s*,\s*Amount\s*,\s*Currency\s*$/i.test(line)) {
      const block: string[] = [line]
      for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex++) {
        const rowLine = lines[rowIndex]
        if (!rowLine.trim() || /^Meta Ads payment$/i.test(rowLine.trim())) break
        if (/Total Amount Billed/i.test(rowLine)) break
        block.push(rowLine)
      }
      parseCsv(block.join('\n')).forEach(row => {
        tableRows.push({
          ...row,
          'Payment method': paymentMethod,
          'Payment status': 'Paid',
        })
      })
    }
  }

  return sawMetaSummary ? tableRows : null
}

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const accountId = String(form.get('accountId') ?? '').trim()
  const file = form.get('file')

  if (!accountId) return NextResponse.json({ error: 'Ad account is required' }, { status: 400 })
  if (!(file instanceof File)) return NextResponse.json({ error: 'Import file is required' }, { status: 400 })

  const account = await prisma.metaAdAccount.findUnique({ where: { id: accountId } })
  if (!account) return NextResponse.json({ error: 'Ad account not found' }, { status: 404 })

  const rows = parseRows(file, await file.arrayBuffer())
  let imported = 0
  let updated = 0
  let skipped = 0
  const errors: Array<{ row: number; error: string }> = []

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const rowNumber = index + 2
    const transactionId = pick(row, ['Transaction ID', 'Transaction Id', 'ID']).replace(/\s+/g, '')
    const status = pick(row, ['Payment status', 'Status'])
    const date = parseDate(pick(row, ['Date', 'Transaction Date', 'Billing Date']))
    const amount = parseAmount(pick(row, ['Amount', 'Total', 'Paid Amount']))
    const currency = pick(row, ['Currency']) || account.currency || 'USD'
    const paymentRaw = pick(row, ['Payment method', 'Payment Method'])
    const referenceNumber = pick(row, ['Reference number', 'Reference Number']) || transactionId
    const receiptUrl = pick(row, ['Receipt URL', 'Receipt Url', 'Download URL', 'Download Url'])

    if (!transactionId && !date && !amount) {
      skipped++
      continue
    }
    if (!/paid/i.test(status)) {
      skipped++
      continue
    }
    if (!transactionId) {
      errors.push({ row: rowNumber, error: 'Missing Transaction ID' })
      continue
    }
    if (!date) {
      errors.push({ row: rowNumber, error: 'Invalid Date' })
      continue
    }
    if (amount <= 0) {
      errors.push({ row: rowNumber, error: 'Invalid Amount' })
      continue
    }

    const payment = parsePaymentMethod(paymentRaw)
    const paymentMethod = payment.code && payment.label ? `${payment.label} ${payment.code}` : payment.label
    const existing = await prisma.metaBilling.findUnique({ where: { id: transactionId } })

    if (existing) {
      await prisma.metaBilling.update({
        where: { id: transactionId },
        data: {
          amount,
          currency,
          billingDate: date,
          status: 'PAID',
          paymentMethod: paymentMethod ?? existing.paymentMethod,
          paymentMethodLast4: payment.last4 ?? existing.paymentMethodLast4,
          referenceNumber: referenceNumber || existing.referenceNumber,
          receiptUrl: receiptUrl || existing.receiptUrl,
        },
      })
      updated++
    } else {
      await prisma.metaBilling.create({
        data: {
          id: transactionId,
          adAccountId: account.id,
          amount,
          currency,
          billingDate: date,
          status: 'PAID',
          chargeType: 'manual_import',
          productType: 'meta_billing_export',
          paymentMethod,
          paymentMethodLast4: payment.last4,
          referenceNumber,
          receiptUrl: receiptUrl || null,
        },
      })
      imported++
    }
  }

  await prisma.metaAdAccount.update({ where: { id: account.id }, data: { lastSyncAt: new Date() } })

  return NextResponse.json({
    success: true,
    rows: rows.length,
    imported,
    updated,
    skipped,
    errors,
  })
}
