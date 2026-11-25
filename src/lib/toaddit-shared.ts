export const TOADDIT_ORIGIN = 'https://ros-openapi.toaddit.com'
export const isToadditSupplier = (s: { code?: string | null; apiType?: string | null } | null | undefined) =>
  !!s && [s.code, s.apiType].some(v => v?.trim().toLowerCase() === 'toaddit')

export function toadditId(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const id = String(value).trim()
  return /^[1-9]\d{0,39}$/.test(id) ? id : null
}

export const toadditVariantId = (productCode: string, size: string) => `ros:${JSON.stringify([productCode, size])}`
export function validToadditVariantId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200 || !value.startsWith('ros:')) return false
  try {
    const pair = JSON.parse(value.slice(4))
    return Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string' && !!v.trim() && !/[\r\n\u0000]/.test(v)) && toadditVariantId(pair[0], pair[1]) === value
  } catch { return false }
}
export type ToadditPreviewInfo = {
  protocol: 'ros-v1'
  products: Array<{ refId: string; shopifyLineId: string; variantId: string; productCode: string; size: string; name: string }>
  options: Array<{ id: string; productCode: string; size: string; name: string }>
}
