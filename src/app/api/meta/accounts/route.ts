import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getMetaExchangeRates, saveMetaExchangeRate } from '@/lib/meta-exchange-rates'

const SUPPORTED_CURRENCIES = new Set(['USD', 'VND'])
const SAFE_ACCOUNT_SELECT = {
  id: true,
  accountId: true,
  accountName: true,
  currency: true,
  projectId: true,
  project: true,
  lastSyncAt: true,
  createdAt: true,
} as const

function parseCurrency(value: unknown) {
  const currency = String(value ?? 'USD').trim().toUpperCase()
  return SUPPORTED_CURRENCIES.has(currency) ? currency : null
}

function parseExchangeRate(value: unknown) {
  if (value === '' || value === null || value === undefined) return null
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

async function addExchangeRates<T extends { id: string }>(accounts: T[]) {
  const rates = await getMetaExchangeRates(accounts.map(account => account.id))
  return accounts.map(account => ({ ...account, exchangeRate: rates.get(account.id) ?? null }))
}

export async function GET() {
  const accounts = await prisma.metaAdAccount.findMany({
    orderBy: { createdAt: 'asc' },
    select: SAFE_ACCOUNT_SELECT,
  })
  return NextResponse.json(await addExchangeRates(accounts))
}

export async function POST(req: NextRequest) {
  const { accountId, accountName, accessToken, projectId, currency: rawCurrency, exchangeRate: rawExchangeRate } = await req.json()
  if (!accountId || !accessToken) {
    return NextResponse.json({ error: 'accountId and accessToken required' }, { status: 400 })
  }
  const currency = parseCurrency(rawCurrency)
  const exchangeRate = parseExchangeRate(rawExchangeRate)
  if (!currency) return NextResponse.json({ error: 'Currency must be USD or VND' }, { status: 400 })
  if (currency === 'VND' && exchangeRate === null) {
    return NextResponse.json({ error: 'Exchange rate is required for a VND account' }, { status: 400 })
  }
  const clean = accountId.trim().startsWith('act_') ? accountId.trim() : `act_${accountId.trim()}`
  const account = await prisma.metaAdAccount.upsert({
    where: { accountId: clean },
    create: { accountId: clean, accountName: accountName || null, accessToken, projectId: projectId || null, currency },
    update: { accountName: accountName || null, accessToken, projectId: projectId || null, currency },
    select: SAFE_ACCOUNT_SELECT,
  })
  await saveMetaExchangeRate(account.id, currency === 'USD' ? null : exchangeRate)
  return NextResponse.json({ ...account, exchangeRate: currency === 'USD' ? null : exchangeRate })
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json()
  await prisma.metaBilling.deleteMany({ where: { adAccountId: id } })
  await prisma.dailyAdSpend.deleteMany({ where: { adAccountId: id } })
  await saveMetaExchangeRate(id, null)
  await prisma.metaAdAccount.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  const body = await req.json()
  const { id } = body
  if (!id) return NextResponse.json({ error: 'Account id is required' }, { status: 400 })

  const updates: { projectId?: string | null; currency?: string; accessToken?: string } = {}
  if ('projectId' in body) updates.projectId = body.projectId || null
  if ('accessToken' in body) {
    const accessToken = String(body.accessToken ?? '').trim()
    if (!accessToken) return NextResponse.json({ error: 'Access token cannot be empty' }, { status: 400 })
    updates.accessToken = accessToken
  }

  let currency: string | null = null
  let exchangeRate: number | null = null
  if ('currency' in body) {
    currency = parseCurrency(body.currency)
    exchangeRate = parseExchangeRate(body.exchangeRate)
    if (!currency) return NextResponse.json({ error: 'Currency must be USD or VND' }, { status: 400 })
    if (currency === 'VND' && exchangeRate === null) {
      return NextResponse.json({ error: 'Exchange rate is required for a VND account' }, { status: 400 })
    }
    updates.currency = currency
  }

  const account = await prisma.metaAdAccount.update({
    where: { id },
    data: updates,
    select: SAFE_ACCOUNT_SELECT,
  })
  if (currency) {
    await Promise.all([
      saveMetaExchangeRate(id, currency === 'USD' ? null : exchangeRate),
      prisma.dailyAdSpend.updateMany({ where: { adAccountId: id }, data: { currency } }),
    ])
  }
  const rates = await getMetaExchangeRates([id])
  return NextResponse.json({ ...account, exchangeRate: rates.get(id) ?? null })
}
