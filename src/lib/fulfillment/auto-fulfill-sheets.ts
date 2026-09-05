import { prisma } from '@/lib/db'

export const DEFAULT_STORE_BASE = 'https://litzzy.com'
export const DEFAULT_MIN_AGE_DAYS = 5
const SHEETS_KEY = 'auto_fulfill_sheets'
const MIN_AGE_KEY = 'auto_fulfill_min_age_days'

export type SheetConfig = { id: string; name: string; url: string; enabled: boolean; storeBase: string }

export function parseSheetsJson(value: string | null | undefined): SheetConfig[] {
  if (!value) return []
  let arr: any
  try { arr = JSON.parse(value) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr
    .filter(x => x && typeof x.url === 'string' && x.url.trim())
    .map((x, i) => ({
      id: String(x.id ?? i + 1),
      name: String(x.name ?? '').trim(),
      url: String(x.url).trim(),
      enabled: x.enabled !== false,
      storeBase: (typeof x.storeBase === 'string' && x.storeBase.trim()) ? x.storeBase.trim() : DEFAULT_STORE_BASE,
    }))
}

export async function getSheets(): Promise<SheetConfig[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SHEETS_KEY } })
  return parseSheetsJson(row?.value)
}

export async function saveSheets(list: SheetConfig[]): Promise<void> {
  const value = JSON.stringify(parseSheetsJson(JSON.stringify(list)))
  await prisma.appSetting.upsert({ where: { key: SHEETS_KEY }, create: { key: SHEETS_KEY, value }, update: { value } })
}

export async function getMinAgeDays(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: MIN_AGE_KEY } })
  const n = Number(row?.value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MIN_AGE_DAYS
}

export function coerceMinAgeDays(n: unknown): number {
  const num = Number(n)
  if (!Number.isFinite(num)) return DEFAULT_MIN_AGE_DAYS
  return Math.max(0, Math.floor(num))
}

export async function setMinAgeDays(n: number): Promise<void> {
  const value = String(coerceMinAgeDays(n))
  await prisma.appSetting.upsert({ where: { key: MIN_AGE_KEY }, create: { key: MIN_AGE_KEY, value }, update: { value } })
}
