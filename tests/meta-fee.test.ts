import { describe, it, expect } from 'vitest'
import { billingFxFeeUsd, sumBillingFxFeesUsd, FX_FEE_RATE, USD_CARD_FEE_RATE } from '@/lib/meta-fee'

const schedule: any[] = []
const vndCards = new Set(['7619'])
const bill = (amount: number, currency: string, last4: string | null) => ({ amount, currency, billingDate: '2026-10-15', paymentMethodLast4: last4 })

describe('billingFxFeeUsd', () => {
  it('a USD charge on a VND card pays the 3% conversion fee', () => {
    expect(billingFxFeeUsd(bill(100, 'USD', '7619'), vndCards, schedule)).toBeCloseTo(3)
    expect(FX_FEE_RATE).toBe(0.03)
  })

  it('a USD charge on any other card pays the 0.1% fee', () => {
    expect(billingFxFeeUsd(bill(100, 'USD', '1234'), vndCards, schedule)).toBeCloseTo(0.1)
    expect(USD_CARD_FEE_RATE).toBe(0.001)
  })

  it('a USD charge with no card on record is treated as a non-VND card', () => {
    expect(billingFxFeeUsd(bill(100, 'USD', null), vndCards, schedule)).toBeCloseTo(0.1)
  })

  it('a charge in VND pays no fee at all', () => {
    expect(billingFxFeeUsd(bill(2_500_000, 'VND', '7619'), vndCards, schedule)).toBe(0)
  })

  it('sums the two rates across a mixed set of billings', () => {
    const total = sumBillingFxFeesUsd(
      [bill(100, 'USD', '7619'), bill(200, 'USD', '1234'), bill(2_500_000, 'VND', '7619')],
      vndCards, schedule,
    )
    expect(total).toBeCloseTo(3 + 0.2)
  })
})
