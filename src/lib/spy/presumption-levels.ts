export const LEVELS = ['SALES', 'SALES_STRONG', 'SCALE', 'SCALE_STRONG', 'NEW_NEW_SCALE'] as const
export type Level = typeof LEVELS[number]

export const LEVEL_LABELS: Record<Level, string> = {
  NEW_NEW_SCALE: 'New-new scale',
  SCALE_STRONG: 'Scale mạnh',
  SCALE: 'Scale',
  SALES_STRONG: 'Sales mạnh',
  SALES: 'Sales',
}
