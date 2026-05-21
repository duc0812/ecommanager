export type GoalMetricsInput = {
  totalRevenue: number
  daysElapsed: number
  daysInMonth: number
  monthlyTarget: number
  dailyTarget: number
}

export type GoalMetrics = {
  avgDaily: number
  daysRemaining: number
  projected: number
  shortfall: number
  neededPerDay: number
  paceOk: boolean
  monthPct: number
}

export function calcGoalMetrics(input: GoalMetricsInput): GoalMetrics {
  const { totalRevenue, daysElapsed, daysInMonth, monthlyTarget, dailyTarget } = input
  const avgDaily = daysElapsed > 0 ? totalRevenue / daysElapsed : 0
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed)
  const projected = totalRevenue + avgDaily * daysRemaining
  const shortfall = Math.max(0, monthlyTarget - totalRevenue)
  const neededPerDay = daysRemaining > 0 ? shortfall / daysRemaining : 0
  const paceOk = avgDaily >= dailyTarget
  const monthPct = monthlyTarget > 0 ? Math.min(100, (totalRevenue / monthlyTarget) * 100) : 0
  return { avgDaily, daysRemaining, projected, shortfall, neededPerDay, paceOk, monthPct }
}
