// ISO 4217 zero-decimal currencies (Meta trả balance ở đơn vị nhỏ nhất; các currency này không có phần thập phân).
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'VND', 'JPY', 'KRW', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'XOF', 'XAF', 'PYG', 'RWF', 'VUV',
])

function normalizeCurrency(currency: string | null): string {
  return (currency ?? '').trim().toUpperCase() || 'USD'
}

export function buildAccountBalanceUpdate(
  json: Record<string, unknown>,
  currency: string | null,
  now: Date,
): { balance: number | null; balanceCurrency: string | null; balanceSyncedAt: Date } {
  const code = (currency ?? (typeof json.currency === 'string' ? json.currency : null))
  return {
    balance: metaBalanceToMajor(json.balance, code),
    balanceCurrency: code ? code.trim().toUpperCase() : null,
    balanceSyncedAt: now,
  }
}

export function metaBalanceToMajor(raw: unknown, currency: string | null): number | null {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (text === '') return null
  const minor = Number(text)
  if (!Number.isFinite(minor)) return null
  const code = normalizeCurrency(currency)
  const divisor = ZERO_DECIMAL_CURRENCIES.has(code) ? 1 : 100
  return minor / divisor
}
