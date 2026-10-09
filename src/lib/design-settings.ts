import { prisma } from '@/lib/db'

export type DesignSettings = {
  slaCustomHours: number
  slaNonCustomHours: number
  kpiByType: Record<string, number>
  rejectReasons: string[]
}

export const DEFAULT_DESIGN_SETTINGS: DesignSettings = {
  slaCustomHours: 24,
  slaNonCustomHours: 48,
  kpiByType: { jersey: 0.3, shirt: 0.3, hoodie: 0.4, socks: 0.4, ornament: 0.2, tumbler: 0.15, mug: 0.15, default: 0.3 },
  rejectReasons: ['Sai chính tả / nội dung', 'Lệch tâm / ra ngoài vùng an toàn', 'Thiếu nét', 'Sai màu / biến thể', 'Thiếu bleed', 'Font sai'],
}

const KEY = 'design.settings'

export async function getDesignSettings(): Promise<DesignSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
  if (!row) return DEFAULT_DESIGN_SETTINGS
  try {
    const parsed = JSON.parse(row.value)
    return {
      ...DEFAULT_DESIGN_SETTINGS,
      ...parsed,
      kpiByType: { ...DEFAULT_DESIGN_SETTINGS.kpiByType, ...(parsed.kpiByType ?? {}) },
      rejectReasons: Array.isArray(parsed.rejectReasons) && parsed.rejectReasons.length ? parsed.rejectReasons : DEFAULT_DESIGN_SETTINGS.rejectReasons,
    }
  } catch { return DEFAULT_DESIGN_SETTINGS }
}

export async function saveDesignSettings(s: DesignSettings) {
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } })
}

export function kpiForProductType(s: DesignSettings, productType: string | null): number {
  const t = (productType ?? '').toLowerCase()
  for (const [k, v] of Object.entries(s.kpiByType)) if (k !== 'default' && t.includes(k)) return v
  return s.kpiByType.default ?? 0.3
}
