export function isPrintpossSupplier(s: { code?: string | null; apiType?: string | null } | null | undefined): boolean {
  return !!s && [s.code, s.apiType].some(v => v?.trim().toLowerCase() === 'printposs')
}

export function printpossId(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (!/^\d+$/.test(String(value).trim())) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
