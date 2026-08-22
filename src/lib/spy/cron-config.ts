export const SPY_CRON_CONFIG_KEY = 'spy.cron_config'

export type SpyCronConfig = {
  productBestSeller: { enabled: boolean; hours: number[] }
  ads: { enabled: boolean; hours: number[] }
}

export const DEFAULT_CRON: SpyCronConfig = {
  productBestSeller: { enabled: true, hours: [8, 20] },
  ads: { enabled: true, hours: [9] },
}

function normHours(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const hs = v.map(Number).filter(h => Number.isInteger(h) && h >= 0 && h <= 23)
  return Array.from(new Set(hs)).sort((a, b) => a - b)
}

function group(o: any, key: keyof SpyCronConfig): { enabled: boolean; hours: number[] } {
  const g = o?.[key]
  return {
    enabled: typeof g?.enabled === 'boolean' ? g.enabled : DEFAULT_CRON[key].enabled,
    hours: Array.isArray(g?.hours) ? normHours(g.hours) : DEFAULT_CRON[key].hours,
  }
}

export function parseCronConfig(json: string | null | undefined): SpyCronConfig {
  if (!json) return DEFAULT_CRON
  try {
    const o = JSON.parse(json)
    return { productBestSeller: group(o, 'productBestSeller'), ads: group(o, 'ads') }
  } catch {
    return DEFAULT_CRON
  }
}

export function cronExpr(hours: number[]): string | null {
  const hs = normHours(hours)
  return hs.length ? `0 ${hs.join(',')} * * *` : null
}
