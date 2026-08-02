function numericAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') return Number(value.replace(/,/g, '')) || 0
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return numericAmount(object.total_amount ?? object.amount ?? object.value)
  }
  return 0
}

export function metaCurrencyMinorUnitDigits(currency: string) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.trim().toUpperCase(),
    }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

export function normalizeMetaActivityAmount(value: unknown, currency: string) {
  const divisor = 10 ** metaCurrencyMinorUnitDigits(currency)
  return numericAmount(value) / divisor
}

export function metaBillingDateInTimezone(value: unknown, timezoneName?: string | null) {
  const date = typeof value === 'number' ? new Date(value * 1_000) : new Date(String(value ?? ''))
  if (Number.isNaN(date.getTime())) return new Date().toISOString().split('T')[0]
  if (!timezoneName) return date.toISOString().split('T')[0]

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezoneName,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const year = parts.find(part => part.type === 'year')?.value
    const month = parts.find(part => part.type === 'month')?.value
    const day = parts.find(part => part.type === 'day')?.value
    return year && month && day ? `${year}-${month}-${day}` : date.toISOString().split('T')[0]
  } catch {
    return date.toISOString().split('T')[0]
  }
}
