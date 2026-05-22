import { NextRequest, NextResponse } from 'next/server'
import { fetchAllPayouts, fetchBalance, fetchBankAccounts, getCredentialsFromRequest } from '@/lib/shopify'
import { getShopifyConnection } from '@/lib/token-store'
import { SHOPIFY_PAYOUT_START_DATE } from '@/lib/shopify-payout-policy'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const requestedDateMin = searchParams.get('date_min') ?? undefined
  const date_min = requestedDateMin && requestedDateMin > SHOPIFY_PAYOUT_START_DATE
    ? requestedDateMin
    : SHOPIFY_PAYOUT_START_DATE
  const date_max = searchParams.get('date_max') ?? undefined

  try {
    const stored = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
    const creds = stored
      ? { shop: stored.shop, token: stored.token }
      : getCredentialsFromRequest(req)

    // Fetch payouts first to get bank_account_ids for fallback lookup
    const payouts = await fetchAllPayouts(creds, { date_min, date_max })
    const bankAccountIds = Array.from(new Set(payouts.map(p => p.bank_account_id).filter(Boolean))) as number[]

    const [balanceResult, bankAccountsResult] = await Promise.all([
      fetchBalance(creds).catch((e) => { console.error('[balance]', e.message); return { error: e.message, currency: null, amount: null } }),
      fetchBankAccounts(creds, bankAccountIds).catch((e) => { console.error('[bankAccounts]', e.message); return { error: e.message, accounts: [] as any[] } }),
    ])
    console.log('[bankAccountsResult]', JSON.stringify(bankAccountsResult).slice(0, 500))

    const bankAccounts = Array.isArray(bankAccountsResult)
      ? bankAccountsResult
      : (bankAccountsResult as any).accounts ?? []
    const bankAccountsError = Array.isArray(bankAccountsResult)
      ? null
      : (bankAccountsResult as any).error

    // Build per-bank payout summary
    // Shopify REST doesn't return bank_account_id on payouts, so we assign
    // all paid payouts to the bank account(s) from GraphQL
    const bankSummary: Record<string, { bank: any; total: number; count: number; currency: string }> = {}

    const paidPayouts = payouts.filter(p => p.status === 'paid')

    if (bankAccounts.length > 0) {
      // All payouts go to the single/primary bank account
      const primaryBank = bankAccounts[0]
      bankSummary[primaryBank.id] = {
        bank: primaryBank,
        total: paidPayouts.reduce((sum, p) => sum + parseFloat(p.amount), 0),
        count: paidPayouts.length,
        currency: paidPayouts[0]?.currency ?? primaryBank.currency,
      }
    } else {
      // No bank account info — group all under unknown
      if (paidPayouts.length > 0) {
        bankSummary['unknown'] = {
          bank: null,
          total: paidPayouts.reduce((sum, p) => sum + parseFloat(p.amount), 0),
          count: paidPayouts.length,
          currency: paidPayouts[0]?.currency ?? 'USD',
        }
      }
    }

    const stats = {
      total_payouts: payouts.length,
      total_paid: payouts.filter(p => p.status === 'paid').length,
      total_amount_paid: payouts
        .filter(p => p.status === 'paid')
        .reduce((sum, p) => sum + parseFloat(p.amount), 0)
        .toFixed(2),
      currency: payouts[0]?.currency ?? (balanceResult as any).currency ?? 'USD',
      date_range: payouts.length
        ? { from: payouts.at(-1)?.date, to: payouts[0]?.date }
        : null,
    }

    return NextResponse.json({
      stats,
      payout_start_date: SHOPIFY_PAYOUT_START_DATE,
      balance: balanceResult,
      bankAccounts,
      bankAccountsError,
      bankSummary: Object.values(bankSummary),
      payouts,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
