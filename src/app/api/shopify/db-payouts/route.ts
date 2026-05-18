import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const store = await prisma.shopifyStore.findFirst({
    orderBy: { lastSyncAt: 'desc' },
    include: { bankAccounts: true },
  })

  const payouts = await prisma.payout.findMany({
    orderBy: { date: 'desc' },
  })

  if (payouts.length === 0) {
    return NextResponse.json({ empty: true, lastSyncAt: store?.lastSyncAt ?? null })
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
    bank_account_id: p.bankAccountShopifyId ? Number(p.bankAccountShopifyId) : null,
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
    id: Number(b.id),
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
  })
}
