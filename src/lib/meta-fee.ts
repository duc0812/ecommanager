import { prisma } from '@/lib/db'
import { convertMetaAmountToUsdDated, normalizeMetaCurrency } from '@/lib/meta-currency'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'

// A Vietnamese bank card charged by Meta in USD incurs a ~3% FX conversion fee.
export const FX_FEE_RATE = 0.03
// Every other card charged in USD still pays a 0.1% transaction fee.
export const USD_CARD_FEE_RATE = 0.001

export const PAID_META_STATUSES = ['PAID', 'SETTLED', 'COMPLETED']
const PAID_STATUSES = PAID_META_STATUSES

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

// The card fee (USD) for one billing: only USD charges pay one — 3% on a VND card, 0.1% on any other
// card (a billing with no card on record counts as a non-VND card).
export function billingFxFeeUsd(b: FeeBilling, vndCards: Set<string>, schedule: Schedule): number {
  if (normalizeMetaCurrency(b.currency) !== 'USD') return 0
  const usd = convertMetaAmountToUsdDated(b.amount, b.currency, b.billingDate, schedule) ?? 0
  const vndCard = !!b.paymentMethodLast4 && vndCards.has(b.paymentMethodLast4)
  return usd * (vndCard ? FX_FEE_RATE : USD_CARD_FEE_RATE)
}

export function sumBillingFxFeesUsd(bills: FeeBilling[], vndCards: Set<string>, schedule: Schedule): number {
  return bills.reduce((sum, b) => sum + billingFxFeeUsd(b, vndCards, schedule), 0)
}
