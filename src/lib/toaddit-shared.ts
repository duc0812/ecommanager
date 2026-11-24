export type ToadditEnvironment = 'production' | 'sandbox'
export const TOADDIT_HOSTS = { production: 'https://openapi.toaddit.com', sandbox: 'https://openapi-sandbox.toaddit.com' } as const
export const isToadditSupplier = (s: { code?: string | null; apiType?: string | null } | null | undefined) =>
  !!s && [s.code, s.apiType].some(v => v?.trim().toLowerCase() === 'toaddit')

export function toadditId(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const id = String(value).trim()
  return /^[1-9]\d{0,39}$/.test(id) ? id : null
}

export type ToadditTemplateChoice = { refId: string; shopifyLineId: string; templateId: string; name: string; sku: string; images: string[] }
export type ToadditPreviewInfo = {
  environment: ToadditEnvironment; payOnCreate: boolean; templates: ToadditTemplateChoice[]
  options: Array<{ id: string; name: string; sku: string }>
}
