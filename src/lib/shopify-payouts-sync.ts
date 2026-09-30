import { fetchAllPayouts, fetchBalance, fetchBankAccounts } from '@/lib/shopify'
import { getShopifyConnection } from '@/lib/token-store'
import { prisma } from '@/lib/db'
import { SHOPIFY_PAYOUT_START_DATE } from '@/lib/shopify-payout-policy'

export class PayoutSyncError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

// Moved out of the route so the daily scheduler can run it in-process: a cron carries no
// session cookie, and every other scheduler in this app calls its lib directly.
export async function syncShopifyPayouts(
  { requestedDateMin, dateMax }: { requestedDateMin?: string; dateMax?: string } = {},
) {
  const dateMin = requestedDateMin && requestedDateMin > SHOPIFY_PAYOUT_START_DATE
  ? requestedDateMin
  : SHOPIFY_PAYOUT_START_DATE
  if (dateMax && dateMax < dateMin) throw new PayoutSyncError('date_max must be on or after date_min', 400)

  const stored = await getShopifyConnection()
  if (!stored) throw new PayoutSyncError('Not connected to Shopify. Go to /setup and connect Shopify first.', 401)
  const creds = { shop: stored.shop, token: stored.token }


  // Upsert the store record
  const store = await prisma.shopifyStore.upsert({
    where: { shop: creds.shop },
    create: { shop: creds.shop },
    update: { lastSyncAt: new Date() },
  })

  // Fetch all payouts + balance + bank accounts in parallel
  const [payouts, balance, bankAccounts] = await Promise.all([
    fetchAllPayouts(creds, { date_min: dateMin, date_max: dateMax }),
    fetchBalance(creds).catch(() => null),
    fetchBankAccounts(creds).catch(() => []),
  ])

  // Upsert bank accounts
  for (const ba of bankAccounts) {
    await prisma.bankAccount.upsert({
      where: { id: String(ba.id) },
      create: {
        id: String(ba.id),
        storeId: store.id,
        accountNumber: ba.account_number,
        bankName: ba.bank_name,
        country: ba.country,
        currency: ba.currency,
        status: (ba as any).status ?? (ba.verified ? 'VALIDATED' : 'PENDING'),
      },
      update: {
        storeId: store.id,
        accountNumber: ba.account_number,
        bankName: ba.bank_name,
        country: ba.country,
        currency: ba.currency,
        status: (ba as any).status ?? (ba.verified ? 'VALIDATED' : 'PENDING'),
        fetchedAt: new Date(),
      },
    })
  }

  // Upsert payouts
  let synced = 0
  for (const p of payouts) {
    if (p.date < dateMin || (dateMax && p.date > dateMax)) continue
    const bankAccountShopifyId = p.bank_account_id
      ? String(p.bank_account_id)
      : (bankAccounts[0] ? String(bankAccounts[0].id) : null)
    await prisma.payout.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        storeId: store.id,
        status: p.status,
        date: p.date,
        currency: p.currency,
        amount: parseFloat(p.amount),
        chargesFeeAmount: parseFloat(p.summary.charges_fee_amount || '0'),
        chargesGrossAmount: parseFloat(p.summary.charges_gross_amount || '0'),
        refundsFeeAmount: parseFloat(p.summary.refunds_fee_amount || '0'),
        refundsGrossAmount: parseFloat(p.summary.refunds_gross_amount || '0'),
        adjustmentsFeeAmount: parseFloat(p.summary.adjustments_fee_amount || '0'),
        adjustmentsGrossAmount: parseFloat(p.summary.adjustments_gross_amount || '0'),
        bankAccountShopifyId,
      },
      update: {
        storeId: store.id,
        status: p.status,
        date: p.date,
        currency: p.currency,
        amount: parseFloat(p.amount),
        chargesFeeAmount: parseFloat(p.summary.charges_fee_amount || '0'),
        chargesGrossAmount: parseFloat(p.summary.charges_gross_amount || '0'),
        refundsFeeAmount: parseFloat(p.summary.refunds_fee_amount || '0'),
        refundsGrossAmount: parseFloat(p.summary.refunds_gross_amount || '0'),
        adjustmentsFeeAmount: parseFloat(p.summary.adjustments_fee_amount || '0'),
        adjustmentsGrossAmount: parseFloat(p.summary.adjustments_gross_amount || '0'),
        bankAccountShopifyId,
        fetchedAt: new Date(),
      },
    })
    synced++
  }

  // Update lastSyncAt + balance
  await prisma.shopifyStore.update({
    where: { id: store.id },
    data: {
      lastSyncAt: new Date(),
      ...(balance?.amount != null ? {
        currentBalance: parseFloat(balance.amount),
        currentBalanceCurrency: balance.currency ?? null,
      } : {}),
    },
  })

  return {
  success: true,
    synced_payouts: synced,
    synced_bank_accounts: bankAccounts.length,
    payout_start_date: SHOPIFY_PAYOUT_START_DATE,
    date_range: { from: dateMin, to: dateMax ?? null },
  store: { id: store.id, shop: store.shop },
  }
}
