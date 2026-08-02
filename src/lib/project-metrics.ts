export const PROJECT_REVENUE_EXCLUDED_STATUSES = ['REFUNDED', 'CANCELLED'] as const

export type ProjectOrderFinancials = {
  grossAmount: number
  totalFees: number
}

export function summarizeProjectOrderFinancials(orders: ProjectOrderFinancials[]) {
  return orders.reduce((summary, order) => ({
    totalRevenue: summary.totalRevenue + order.grossAmount,
    totalPaymentFees: summary.totalPaymentFees + order.totalFees,
  }), { totalRevenue: 0, totalPaymentFees: 0 })
}
