import { prisma } from '@/lib/db'
import type { ToadditEnvironment } from '@/lib/toaddit-shared'

export const TOADDIT_KEYS = {
  appKey: 'toaddit.appKey', appSecret: 'toaddit.appSecret', environment: 'toaddit.environment',
  shippingMethod: 'toaddit.shippingMethod', payOnCreate: 'toaddit.payOnCreate',
} as const
export type ToadditSettings = { appKey: string | null; appSecret: string | null; environment: ToadditEnvironment; shippingMethod: '1' | '2'; payOnCreate: boolean }
export const hasToadditCredentials = (s: ToadditSettings) => !!s.appKey && !!s.appSecret
export function toadditSettingsView(s: ToadditSettings) {
  return { hasAppKey: !!s.appKey, hasAppSecret: !!s.appSecret, hasCredentials: hasToadditCredentials(s), environment: s.environment, shippingMethod: s.shippingMethod, payOnCreate: s.payOnCreate }
}
export async function getToadditSettings(): Promise<ToadditSettings> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(TOADDIT_KEYS) } } })
  const raw = new Map(rows.map(r => [r.key, r.value.trim()]))
  return { appKey: raw.get(TOADDIT_KEYS.appKey) || null, appSecret: raw.get(TOADDIT_KEYS.appSecret) || null,
    environment: raw.get(TOADDIT_KEYS.environment) === 'sandbox' ? 'sandbox' : 'production',
    shippingMethod: raw.get(TOADDIT_KEYS.shippingMethod) === '2' ? '2' : '1', payOnCreate: raw.get(TOADDIT_KEYS.payOnCreate) === 'true' }
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
    if (patch.appKey !== undefined || patch.appSecret !== undefined || patch.environment !== undefined) {
      await tx.appSetting.deleteMany({ where: { key: { startsWith: 'toaddit.session.' } } })
    }
  })
  return getToadditSettings()
}
