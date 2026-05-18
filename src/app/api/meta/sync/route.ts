import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v19.0'

type MetaTransaction = {
  id: string
  legacyId?: string | null
  amount: number
  currency: string
  billingDate: string
  status: string
  chargeType: string | null
  productType: string | null
  paymentMethod: string | null
  paymentMethodLast4: string | null
  referenceNumber: string | null
  receiptUrl: string | null
}

type MetaPaymentMethod = {
  label: string | null
  last4: string | null
}

function graphUrl(path: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
  return url.toString()
}

function parseAmount(value: any): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value.replace(/,/g, '')) || 0
  if (value && typeof value === 'object') {
    return parseAmount(value.total_amount ?? value.amount ?? value.value)
  }
  return 0
}

function parseCurrency(txn: any): string {
  return txn.currency ?? txn.amount?.currency ?? txn.app_amount?.currency ?? 'USD'
}

function parseLast4(value: any): string | null {
  if (value == null) return null
  const direct = value.last4 ?? value.last_4 ?? value.card_last_four_digits
  if (direct) return String(direct).slice(-4)

  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const match = text.match(/(?:\*+|x+|\.{2,}|[-\s])(\d{4})(?!\d)/i)
  return match?.[1] ?? null
}

function cleanPaymentMethodLabel(value: string | null) {
  if (!value) return null
  return value.replace(/\s*(?:\*+|x+|\.{2,}|[-\s])\d{4}\s*$/i, '').trim() || value
}

function parseBillingDate(txn: any): string {
  if (txn.created_time) return String(txn.created_time).split('T')[0]
  if (txn.time) return new Date(Number(txn.time) * 1000).toISOString().split('T')[0]
  if (txn.billing_start_time) return new Date(Number(txn.billing_start_time) * 1000).toISOString().split('T')[0]
  return new Date().toISOString().split('T')[0]
}

function normalizeStatus(status: any): string {
  const raw = String(status ?? 'UNKNOWN').toUpperCase()
  if (['COMPLETED', 'COMPLETE', 'PAID', 'SETTLED', 'SUCCESS', 'SUCCEEDED'].includes(raw)) return 'PAID'
  if (['FAILED', 'FAIL', 'DECLINED', 'REJECTED'].includes(raw)) return 'FAILED'
  return raw
}

function parsePaymentMethod(txn: any): string | null {
  const method =
    txn.payment_method ??
    txn.payment_option ??
    txn.funding_source_details?.display_string ??
    txn.funding_source_details?.type

  if (!method) return null
  return String(method)
}

function parseReferenceNumber(txn: any): string | null {
  const reference =
    txn.reference_number ??
    txn.reference_id ??
    txn.receipt_id ??
    txn.fatura_id ??
    txn.payment_reference

  if (!reference && !txn.id) return null
  return String(reference ?? txn.id)
}

function normalizeTransaction(accountId: string, txn: any): MetaTransaction {
  const id = String(txn.id ?? `${accountId}-${txn.time ?? txn.created_time}`)

  return {
    id,
    amount: parseAmount(txn.amount ?? txn.app_amount),
    currency: parseCurrency(txn),
    billingDate: parseBillingDate(txn),
    status: normalizeStatus(txn.status),
    chargeType: txn.charge_type ?? txn.payment_option ?? txn.tx_type ?? null,
    productType: txn.product_type ?? null,
    paymentMethod: parsePaymentMethod(txn),
    paymentMethodLast4: parseLast4(txn.payment_method ?? txn.payment_option ?? txn.funding_source_details),
    referenceNumber: parseReferenceNumber(txn),
    receiptUrl: txn.download_uri ?? txn.receipt_url ?? null,
  }
}

function parseJsonMaybe(value: any) {
  if (!value || typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function dateOnly(date: Date) {
  return date.toISOString().split('T')[0]
}

function parseDateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`)
}

function asText(value: any): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    if (typeof value.__html === 'string') return value.__html.replace(/<[^>]*>/g, '').trim()
    if (typeof value.display_string === 'string') return value.display_string
    if (typeof value.type === 'string') return value.type
  }
  return null
}

function normalizeActivity(accountId: string, activity: any, paymentMethod: MetaPaymentMethod): MetaTransaction | null {
  const eventType = String(activity.event_type ?? activity.type ?? '').toLowerCase()
  const extraData = parseJsonMaybe(activity.extra_data) ?? {}
  const rawAmount =
    extraData.amount ??
    extraData.total_amount ??
    extraData.value ??
    extraData.new_value ??
    activity.amount
  const amount = parseAmount(rawAmount) / 100
  const paymentDataType = String(extraData.type ?? '').toLowerCase()

  if (eventType !== 'ad_account_billing_charge' || paymentDataType !== 'payment_amount' || amount <= 0) {
    return null
  }

  const eventTime = activity.event_time ?? activity.time ?? activity.created_time
  const transactionId = asText(extraData.transaction_id ?? extraData.transactionId)
  const legacyId = `${accountId}-${eventType}-${eventTime}`
  const id = String(activity.id ?? transactionId ?? legacyId)

  return {
    id,
    legacyId: transactionId ? legacyId : null,
    amount,
    currency: extraData.currency ?? activity.currency ?? 'USD',
    billingDate: parseBillingDate({ created_time: eventTime }),
    status: 'PAID',
    chargeType: activity.event_type ?? null,
    productType: 'billing_activity',
    paymentMethod: cleanPaymentMethodLabel(asText(extraData.payment_method ?? extraData.payment_option) ?? paymentMethod.label),
    paymentMethodLast4: parseLast4(extraData.payment_method ?? extraData.payment_option) ?? paymentMethod.last4,
    referenceNumber: asText(extraData.reference_number ?? extraData.reference_id ?? transactionId ?? activity.object_id ?? id),
    receiptUrl: asText(extraData.download_uri ?? extraData.receipt_url),
  }
}

function isUnknownFieldError(err: any, field?: string) {
  const message = String(err?.message ?? '')
  const hasUnknownField = message.includes('nonexisting field') || message.includes('Unknown field')
  return hasUnknownField && (!field || message.includes(field))
}

async function fetchPagedGraphData(url: string) {
  const all: any[] = []
  let nextUrl: string | null = url

  while (nextUrl) {
    const res: Response = await fetch(nextUrl)
    const json: any = await res.json()
    if (json.error) throw new Error(`Meta API: ${json.error.message}`)
    all.push(...(json.data ?? []))
    nextUrl = json.paging?.next ?? null
  }

  return all
}

async function fetchAdAccountPaymentMethod(accountId: string, accessToken: string): Promise<MetaPaymentMethod> {
  const url = graphUrl(accountId, {
    fields: 'funding_source,funding_source_details,currency',
    access_token: accessToken,
  })

  try {
    const res: Response = await fetch(url)
    const json: any = await res.json()
    if (json.error) return { label: null, last4: null }
    const details = json.funding_source_details
    const label = cleanPaymentMethodLabel(asText(details?.display_string ?? details?.readable_card_type ?? details?.card_type ?? details?.type))
    return {
      label,
      last4: parseLast4(details),
    }
  } catch {
    return { label: null, last4: null }
  }
}

async function fetchMetaBillingActivities(accountId: string, accessToken: string, since: string, until: string) {
  const paymentMethod = await fetchAdAccountPaymentMethod(accountId, accessToken)
  const activities: any[] = []
  let cursor = parseDateOnly(since)
  let finalDate = parseDateOnly(until)

  if (cursor >= finalDate) finalDate = addDays(cursor, 1)

  while (cursor < finalDate) {
    const chunkEnd = addDays(cursor, 1)
    const url = graphUrl(`${accountId}/activities`, {
      fields: ['id', 'event_time', 'event_type', 'object_id', 'extra_data'].join(','),
      since: dateOnly(cursor),
      until: dateOnly(chunkEnd),
      limit: '500',
      access_token: accessToken,
    })
    activities.push(...await fetchPagedGraphData(url))
    cursor = chunkEnd
  }

  const byId = new Map<string, MetaTransaction>()
  activities
    .map(activity => normalizeActivity(accountId, activity, paymentMethod))
    .filter((activity): activity is MetaTransaction => Boolean(activity))
    .forEach(activity => byId.set(activity.id, activity))

  return Array.from(byId.values())
}

async function fetchMetaTransactions(accountId: string, accessToken: string, since: string, until: string) {
  const baseFields = [
    'id',
    'time',
    'amount',
    'currency',
    'charge_type',
    'status',
    'payment_option',
    'tx_type',
    'app_amount',
  ]
  const extendedFields = [
    ...baseFields,
    'created_time',
    'product_type',
    'payment_method',
    'reference_number',
    'reference_id',
    'receipt_id',
    'download_uri',
  ]

  async function request(fields: string[]) {
    const url = graphUrl(`${accountId}/transactions`, {
      fields: fields.join(','),
      since,
      until,
      limit: '200',
      access_token: accessToken,
    })

    return fetchPagedGraphData(url)
  }

  let transactions: any[]
  try {
    transactions = await request(extendedFields)
  } catch (err: any) {
    if (!isUnknownFieldError(err)) throw err
    try {
      transactions = await request(baseFields)
    } catch (fallbackErr: any) {
      if (!isUnknownFieldError(fallbackErr, 'transactions')) throw fallbackErr
      return fetchMetaBillingActivities(accountId, accessToken, since, until)
    }
  }

  return transactions.map(txn => normalizeTransaction(accountId, txn))
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { accountId } = body
  const since = body.since ?? '2004-02-04'
  const until = body.until ?? new Date().toISOString().split('T')[0]

  try {
    const where = accountId ? { id: accountId } : {}
    const accounts = await prisma.metaAdAccount.findMany({ where })

    if (accounts.length === 0) {
      return NextResponse.json({ error: 'No accounts found' }, { status: 404 })
    }

    let totalSynced = 0

    for (const account of accounts) {
      const transactions = await fetchMetaTransactions(account.accountId, account.accessToken, since, until)

      for (const txn of transactions) {
        if (txn.legacyId && txn.legacyId !== txn.id) {
          await prisma.metaBilling.deleteMany({
            where: {
              id: txn.legacyId,
              adAccountId: account.id,
            },
          })
        }

        await prisma.metaBilling.upsert({
          where: { id: txn.id },
          create: {
            id: txn.id,
            adAccountId: account.id,
            amount: txn.amount,
            currency: txn.currency,
            billingDate: txn.billingDate,
            status: txn.status,
            chargeType: txn.chargeType,
            productType: txn.productType,
            paymentMethod: txn.paymentMethod,
            paymentMethodLast4: txn.paymentMethodLast4,
            referenceNumber: txn.referenceNumber,
            receiptUrl: txn.receiptUrl,
          },
          update: {
            amount: txn.amount,
            currency: txn.currency,
            billingDate: txn.billingDate,
            status: txn.status,
            chargeType: txn.chargeType,
            productType: txn.productType,
            paymentMethod: txn.paymentMethod,
            paymentMethodLast4: txn.paymentMethodLast4,
            referenceNumber: txn.referenceNumber,
            receiptUrl: txn.receiptUrl,
          },
        })
        totalSynced++
      }

      await prisma.metaAdAccount.update({
        where: { id: account.id },
        data: { lastSyncAt: new Date() },
      })
    }

    return NextResponse.json({ success: true, synced: totalSynced })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
