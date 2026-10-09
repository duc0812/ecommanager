import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { getDesignSettings, saveDesignSettings, DEFAULT_DESIGN_SETTINGS, kpiForProductType } from '@/lib/design-settings'

afterAll(async () => { await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } }) })

describe('design settings', () => {
  it('returns defaults when nothing is stored', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
    expect(await getDesignSettings()).toEqual(DEFAULT_DESIGN_SETTINGS)
  })
  it('round-trips and merges missing keys', async () => {
    await saveDesignSettings({ ...DEFAULT_DESIGN_SETTINGS, slaCustomHours: 12 })
    const s = await getDesignSettings()
    expect(s.slaCustomHours).toBe(12)
    expect(s.rejectReasons).toEqual(DEFAULT_DESIGN_SETTINGS.rejectReasons)
  })
  it('kpiForProductType matches by substring, else default', () => {
    expect(kpiForProductType(DEFAULT_DESIGN_SETTINGS, 'Baseball Jersey')).toBe(0.3)
    expect(kpiForProductType(DEFAULT_DESIGN_SETTINGS, 'Crew Socks')).toBe(0.4)
    expect(kpiForProductType(DEFAULT_DESIGN_SETTINGS, null)).toBe(DEFAULT_DESIGN_SETTINGS.kpiByType.default)
  })
})
