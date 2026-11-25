import { prisma } from '@/lib/db'

export const TOADDIT_KEYS = { apiKey: 'toaddit.rosApiKey', shippingMethod: 'toaddit.shippingMethod' } as const
export type ToadditSettings = { apiKey: string | null; shippingMethod: '1' | '2' | '3' }
export const hasToadditCredentials = (s: ToadditSettings) => !!s.apiKey
export function toadditSettingsView(s: ToadditSettings) {
  return { protocol: 'ros-v1' as const, hasApiKey: !!s.apiKey, hasCredentials: hasToadditCredentials(s), shippingMethod: s.shippingMethod }
}
export async function getToadditSettings(): Promise<ToadditSettings> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(TOADDIT_KEYS) } } })
  const raw = new Map(rows.map(r => [r.key, r.value.trim()]))
  const shippingMethod = raw.get(TOADDIT_KEYS.shippingMethod)
  return { apiKey: raw.get(TOADDIT_KEYS.apiKey) || null, shippingMethod: shippingMethod === '2' || shippingMethod === '3' ? shippingMethod : '1' }
}
export async function saveToadditSettings(patch: Partial<ToadditSettings>) {
  await prisma.$transaction(async tx => {
    for (const field of Object.keys(TOADDIT_KEYS) as Array<keyof ToadditSettings>) {
      if (patch[field] === undefined) continue
      const key = TOADDIT_KEYS[field]
      const value = patch[field] === null ? '' : String(patch[field]).trim()
      if (value) await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
      else await tx.appSetting.deleteMany({ where: { key } })
    }
  })
  return getToadditSettings()
}
