import { prisma } from '@/lib/db'

export const PRINTPOSS_KEYS = { token: 'printposs.token', storeId: 'printposs.storeId' } as const
export type PrintpossSettings = { token: string | null; storeId: string | null }

export async function getPrintpossSettings(): Promise<PrintpossSettings> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(PRINTPOSS_KEYS) } } })
  const values = new Map(rows.map(r => [r.key, r.value.trim() || null]))
  return { token: values.get(PRINTPOSS_KEYS.token) ?? null, storeId: values.get(PRINTPOSS_KEYS.storeId) ?? null }
}

export function printpossSettingsView(s: PrintpossSettings) {
  return { hasToken: !!s.token, storeId: s.storeId }
}

export async function savePrintpossSettings(patch: Partial<PrintpossSettings>) {
  await prisma.$transaction(async tx => {
    for (const field of ['token', 'storeId'] as const) {
      if (patch[field] === undefined) continue
      const key = PRINTPOSS_KEYS[field]
      const value = patch[field]?.trim()
      if (value) await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
      else await tx.appSetting.deleteMany({ where: { key } })
    }
  })
  return getPrintpossSettings()
}
