import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { payoutDateMinFor, payoutStartFor } from '@/lib/shopify-payout-policy'
import { listConnectedStores } from '@/lib/store-connections'
import { firstStoreOf } from '@/lib/finance-scope'
import { requireStoreFilter } from '@/lib/store-scope'

export const dynamic = 'force-dynamic'

// One store at a time: balance, bank accounts, payouts, totals and the start date all come from the
// store named by ?storeId, else the first connected store the caller may see, never a mix of stores.
// A store outside a seller's stores is refused.
export async function GET(req: NextRequest) {
  const scope = await requireStoreFilter(req, 'shopify')
  if ('error' in scope) return scope.error
  const requestedDateMin = req.nextUrl.searchParams.get('date_min') ?? undefined
  const dateMax = req.nextUrl.searchParams.get('date_max') ?? undefined
  const rawStoreId = req.nextUrl.searchParams.get('storeId')
  const requestedStoreId = rawStoreId && rawStoreId !== 'all' ? rawStoreId : null

  const storeId = requestedStoreId || firstStoreOf(await listConnectedStores(), scope.storeIds)?.id
  const store = storeId
    ? await prisma.shopifyStore.findUnique({ where: { id: storeId }, include: { bankAccounts: true } })
    : await prisma.shopifyStore.findFirst({
        where: scope.storeIds ? { id: { in: scope.storeIds } } : {},
        orderBy: { connectedAt: 'asc' },
        include: { bankAccounts: true },
      })
  if (requestedStoreId && !store) return NextResponse.json({ error: 'Store not found' }, { status: 404 })
  const shown = store ?? { payoutStartDate: null }
  const payoutStartDate = payoutStartFor(shown)
  const dateMin = payoutDateMinFor(shown, requestedDateMin)
  if (dateMax && dateMax < dateMin) {
    return NextResponse.json({ error: 'date_max must be on or after date_min' }, { status: 400 })
  }

  const payouts = store
    ? await prisma.payout.findMany({
        where: { storeId: store.id, date: { gte: dateMin, ...(dateMax ? { lte: dateMax } : {}) } },
        orderBy: { date: 'desc' },
      })
    : []

  if (payouts.length === 0) {
    return NextResponse.json(
      { empty: true, payout_start_date: payoutStartDate, lastSyncAt: store?.lastSyncAt ?? null },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const paidPayouts = payouts.filter(p => p.status === 'paid')
  const totalAmountPaid = paidPayouts.reduce((s, p) => s + p.amount, 0)
  const dates = payouts.map(p => p.date).sort()

  // Map DB payouts → ShopifyPayout-compatible shape for the Finance page display
  const mappedPayouts = payouts.map(p => ({
    id: p.id,
    status: p.status,
    date: p.date,
    currency: p.currency,
    amount: p.amount.toFixed(2),
    bank_account_id: p.bankAccountShopifyId,
    summary: {
      charges_gross_amount: p.chargesGrossAmount.toFixed(2),
      charges_fee_amount: p.chargesFeeAmount.toFixed(2),
      refunds_gross_amount: p.refundsGrossAmount.toFixed(2),
      refunds_fee_amount: p.refundsFeeAmount.toFixed(2),
      adjustments_gross_amount: p.adjustmentsGrossAmount.toFixed(2),
      adjustments_fee_amount: p.adjustmentsFeeAmount.toFixed(2),
    },
  }))

  const bankAccounts = (store?.bankAccounts ?? []).map(b => ({
    id: b.id,
    bank_name: b.bankName,
    account_number: b.accountNumber,
    country: b.country,
    currency: b.currency,
    verified: b.status === 'VALIDATED',
  }))

  // Bank summary — fallback to first bank account when shopifyId not stored
  const fallbackBank = bankAccounts[0] ?? null
  const bankMap: Record<string, { bank: (typeof bankAccounts)[0] | null; total: number; count: number; currency: string }> = {}
  for (const p of paidPayouts) {
    const rawKey = p.bankAccountShopifyId ?? null
    const resolvedBank = rawKey
      ? (bankAccounts.find(b => String(b.id) === rawKey) ?? fallbackBank)
      : fallbackBank
    const key = rawKey ?? (fallbackBank ? String(fallbackBank.id) : 'unknown')
    if (!bankMap[key]) {
      bankMap[key] = { bank: resolvedBank, total: 0, count: 0, currency: p.currency }
    }
    bankMap[key].total += p.amount
    bankMap[key].count += 1
  }

  return NextResponse.json({
    fromDB: true,
    payout_start_date: payoutStartDate,
    lastSyncAt: store?.lastSyncAt ?? null,
    stats: {
      total_payouts: payouts.length,
      total_paid: paidPayouts.length,
      total_amount_paid: totalAmountPaid.toFixed(2),
      currency: payouts[0]?.currency ?? 'USD',
      date_range: dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null,
    },
    balance: {
      amount: store?.currentBalance != null ? store.currentBalance.toFixed(2) : null,
      currency: store?.currentBalanceCurrency ?? null,
    },
    bankAccounts,
    bankSummary: Object.values(bankMap),
    payouts: mappedPayouts,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
