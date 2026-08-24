import { prisma } from '@/lib/db'
import { convertMetaAmountToUsdDated, normalizeMetaCurrency } from '@/lib/meta-currency'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'

// A Vietnamese bank card charged by Meta in USD incurs a ~3% FX conversion fee.
export const FX_FEE_RATE = 0.03

const PAID_STATUSES = ['PAID', 'SETTLED', 'COMPLETED']

type Schedule = Awaited<ReturnType<typeof getMetaRateSchedule>>
type FeeBilling = { amount: number; currency: string; billingDate: string; paymentMethodLast4: string | null }

// A card (identified by its last 4 digits) is treated as a "VND card" when it has ever
// been charged in a non-USD currency. Determined globally so the fee is consistent across
// the Meta Billing page and every project, regardless of the date/account filter in view.
export async function getVndCardLast4(): Promise<Set<string>> {
  const rows = await prisma.metaBilling.findMany({
    where: { status: { in: PAID_STATUSES }, paymentMethodLast4: { not: null } },
    select: { paymentMethodLast4: true, currency: true },
  })
  const set = new Set<string>()
  for (const r of rows) {
    if (r.paymentMethodLast4 && normalizeMetaCurrency(r.currency) !== 'USD') set.add(r.paymentMethodLast4)
  }
  return set
}

// The FX fee (USD) for one billing: 3% of its USD amount when it is a USD charge on a VND card.
export function billingFxFeeUsd(b: FeeBilling, vndCards: Set<string>, schedule: Schedule): number {
  if (normalizeMetaCurrency(b.currency) !== 'USD') return 0
  if (!b.paymentMethodLast4 || !vndCards.has(b.paymentMethodLast4)) return 0
  const usd = convertMetaAmountToUsdDated(b.amount, b.currency, b.billingDate, schedule) ?? 0
  return usd * FX_FEE_RATE
}

export function sumBillingFxFeesUsd(bills: FeeBilling[], vndCards: Set<string>, schedule: Schedule): number {
  return bills.reduce((sum, b) => sum + billingFxFeeUsd(b, vndCards, schedule), 0)
}
