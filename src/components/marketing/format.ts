const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const int = new Intl.NumberFormat('en-US')

export function fmtUsd(n: number) {
  return usd.format(n)
}

export function fmtMoney(n: number, currency: string) {
  if (currency === 'USD') return usd.format(n)
  return `${int.format(Math.round(n))} ${currency}`
}

export function fmtRoas(n: number | null) {
  return n == null ? '—' : `${n.toFixed(2)}x`
}

export function fmtPct(n: number | null) {
  return n == null ? '—' : `${(n * 100).toFixed(2)}%`
}

export function fmtInt(n: number) {
  return int.format(n)
}

export function fmtDate(key: string | null) {
  if (!key) return '—'
  const [y, m, d] = key.split('-')
  return `${m}/${d}/${y}`
}

export function roasTone(n: number | null) {
  if (n == null) return 'text-on-surface-variant'
  if (n >= 3) return 'text-emerald-700'
  if (n >= 1.5) return 'text-amber-700'
  return 'text-error'
}
