import { describe, it, expect } from 'vitest'
import { commissionRate, computeSellerCommission, KPI } from './seller-commission'

describe('commissionRate', () => {
  it('is 0 below KPI, then 10/15/20% by bracket (whole-profit)', () => {
    expect(commissionRate(999)).toBe(0)
    expect(commissionRate(KPI)).toBe(0.1)
    expect(commissionRate(1499)).toBe(0.1)
    expect(commissionRate(1500)).toBe(0.15)
    expect(commissionRate(4999)).toBe(0.15)
    expect(commissionRate(5000)).toBe(0.2)
  })
})

describe('computeSellerCommission', () => {
  it('matches the worked 6-month example (hit / miss compounding / negative / recovery)', () => {
    const { rows, totalCommission } = computeSellerCommission([
      { month: '2026-01', realized: 1200 },
      { month: '2026-02', realized: 600 },
      { month: '2026-03', realized: 1500 },
      { month: '2026-04', realized: 2000 },
      { month: '2026-05', realized: -400 },
      { month: '2026-06', realized: 3000 },
    ])
    expect(rows.map(r => r.commission)).toEqual([120, 0, 0, 100, 0, 240])
    expect(rows.map(r => r.baseline)).toEqual([0, 1200, 2800, 4300, 5300, 6300])
    expect(rows.map(r => r.profit)).toEqual([1200, 600, 500, 1000, -400, 1600])
    expect(rows[5].rate).toBe(0.15)
    expect(totalCommission).toBe(460)
  })

  it('gives 0 for a seller who never reaches KPI', () => {
    const { totalCommission } = computeSellerCommission([
      { month: '2026-01', realized: 500 },
      { month: '2026-02', realized: 500 },
    ])
    expect(totalCommission).toBe(0)
  })

  it('applies 20% only when whole profit >= 5000', () => {
    const { rows } = computeSellerCommission([{ month: '2026-01', realized: 6000 }])
    expect(rows[0].rate).toBe(0.2)
    expect(rows[0].commission).toBe(1200)
  })
})
