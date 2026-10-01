import { addDays } from '@/lib/cashflow-dates'

export type StockSource = 'LIVE' | 'SNAPSHOT' | 'NONE'

export type CashflowStock = {
  source: StockSource
  asOf: string | null
  shopifyBalance: number | null
  inTransitPayout: number | null
  pendingInvoiceCharge: number | null
  projectedCashflow: number | null
}

export const SNAPSHOT_STOCK_GRACE_DAYS = 2

type StockAmounts = {
  shopifyBalance: number
  inTransitPayout: number
  pendingInvoiceCharge: number
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

// The Shopify balance, the in-transit payouts and the unbilled Meta balance only ever describe
// "now" — neither API exposes history for them. They may stand in for a period end only while
// that end is today or just behind it (the month-end cron fires minutes after a month closes).
export function liveStockAppliesTo(periodEndKey: string, todayKey: string, graceDays = 0): boolean {
  if (periodEndKey >= todayKey) return true
  return addDays(periodEndKey, graceDays) >= todayKey
}

export function emptyStock(): CashflowStock {
  return {
    source: 'NONE',
    asOf: null,
    shopifyBalance: null,
    inTransitPayout: null,
    pendingInvoiceCharge: null,
    projectedCashflow: null,
  }
}

function withProjection(amounts: StockAmounts, source: StockSource, asOf: string): CashflowStock {
  return {
    source,
    asOf,
    ...amounts,
    projectedCashflow: round2(amounts.shopifyBalance + amounts.inTransitPayout - amounts.pendingInvoiceCharge),
  }
}

export function buildLiveStock(amounts: StockAmounts, asOf: string): CashflowStock {
  return withProjection(amounts, 'LIVE', asOf)
}

export function stockFromSnapshot(row: {
  asOfDate: string
  shopifyBalance: number | null
  inTransitPayout: number | null
  pendingInvoiceCharge: number | null
} | null): CashflowStock {
  if (!row) return emptyStock()
  const { shopifyBalance, inTransitPayout, pendingInvoiceCharge } = row
  if (shopifyBalance === null || inTransitPayout === null || pendingInvoiceCharge === null) return emptyStock()
  return withProjection({ shopifyBalance, inTransitPayout, pendingInvoiceCharge }, 'SNAPSHOT', row.asOfDate)
}
