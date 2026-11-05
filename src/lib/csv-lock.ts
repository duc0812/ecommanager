import { prisma } from '@/lib/db'

export const CSV_OPEN_KEY = 'supplier.csvExportOpen'
export const CSV_LOCKED_MESSAGE = 'Xuất CSV đang khoá — gửi đơn ở Duyệt sản xuất. Superadmin mở khoá ở Setup › Fulfill'

/** Owner 11/05/2026: no supplier gets a CSV, every line goes through the hub, until the switch in Setup opens it. */
export async function isCsvLocked(): Promise<boolean> {
  return (await prisma.appSetting.findUnique({ where: { key: CSV_OPEN_KEY } }))?.value !== 'true'
}

export async function setCsvLocked(locked: boolean): Promise<void> {
  const value = locked ? 'false' : 'true'
  await prisma.appSetting.upsert({ where: { key: CSV_OPEN_KEY }, create: { key: CSV_OPEN_KEY, value }, update: { value } })
}
