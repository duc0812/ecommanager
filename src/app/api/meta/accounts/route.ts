import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

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

export async function GET() {
  const accounts = await prisma.metaAdAccount.findMany({
    orderBy: { createdAt: 'asc' },
    select: SAFE_ACCOUNT_SELECT,
  })
  return NextResponse.json(accounts)
}

export async function POST(req: NextRequest) {
  const { accountId, accountName, accessToken, projectId, currency: rawCurrency } = await req.json()
  if (!accountId || !accessToken) {
    return NextResponse.json({ error: 'accountId and accessToken required' }, { status: 400 })
  }
  const currency = parseCurrency(rawCurrency)
  if (!currency) return NextResponse.json({ error: 'Currency must be USD or VND' }, { status: 400 })
  const clean = accountId.trim().startsWith('act_') ? accountId.trim() : `act_${accountId.trim()}`
  const account = await prisma.metaAdAccount.upsert({
    where: { accountId: clean },
    create: { accountId: clean, accountName: accountName || null, accessToken, projectId: projectId || null, currency },
    update: { accountName: accountName || null, accessToken, projectId: projectId || null, currency },
    select: SAFE_ACCOUNT_SELECT,
  })
  return NextResponse.json(account)
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json()
  await prisma.metaBilling.deleteMany({ where: { adAccountId: id } })
  await prisma.dailyAdSpend.deleteMany({ where: { adAccountId: id } })
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

  if ('currency' in body) {
    const currency = parseCurrency(body.currency)
    if (!currency) return NextResponse.json({ error: 'Currency must be USD or VND' }, { status: 400 })
    updates.currency = currency
  }

  const account = await prisma.metaAdAccount.update({
    where: { id },
    data: updates,
    select: SAFE_ACCOUNT_SELECT,
  })
  if ('currency' in body) {
    await prisma.dailyAdSpend.updateMany({ where: { adAccountId: id }, data: { currency: updates.currency } })
  }
  return NextResponse.json(account)
}
