import { describe, expect, it } from 'vitest'
import {
  PROJECT_REVENUE_EXCLUDED_STATUSES,
  summarizeProjectOrderFinancials,
} from '@/lib/project-metrics'

describe('project metrics', () => {
  it('uses the same terminal statuses for every project revenue view', () => {
    expect(PROJECT_REVENUE_EXCLUDED_STATUSES).toEqual(['REFUNDED', 'CANCELLED'])
  })

  it('sums revenue independently from supplier mapping and COGS availability', () => {
    expect(summarizeProjectOrderFinancials([
      { grossAmount: 100, totalFees: 3.2 },
      { grossAmount: 49.95, totalFees: 1.8 },
    ])).toEqual({
      totalRevenue: 149.95,
      totalPaymentFees: 5,
    })
  })
})
