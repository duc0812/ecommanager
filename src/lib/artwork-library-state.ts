import { prisma } from '@/lib/db'
import { toRouteKey } from '@/lib/product-profiles'
import type { EntryStatus } from '@/lib/artwork-fields'
import type { TaskLibraryState } from '@/lib/artwork-library-types'

export async function libraryStateFor(input: { storeId: string | null; shopifyProductId: string | null; templateId: string | null }): Promise<TaskLibraryState | null> {
  if (!input.storeId || !input.shopifyProductId || !input.templateId) return null
  const key = toRouteKey(input.storeId, input.shopifyProductId)
  const e = await prisma.artworkEntry.findUnique({
    where: { storeId_shopifyProductId_printTemplateId: { storeId: input.storeId, shopifyProductId: input.shopifyProductId, printTemplateId: input.templateId } },
    select: { id: true, status: true },
  })
  if (!e) return { key, entryId: null, status: 'NONE', label: 'Thiếu' }
  const status = e.status as EntryStatus
  const label = status === 'READY' ? 'Sẵn sàng' : status === 'QUEUED' || status === 'PARSING' ? 'Đang đọc' : 'Thiếu'
  return { key, entryId: e.id, status, label }
}
