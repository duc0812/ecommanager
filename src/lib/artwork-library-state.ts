import { prisma } from '@/lib/db'
import { toRouteKey } from '@/lib/product-profiles'
import { parseFields, type EntryStatus } from '@/lib/artwork-fields'
import { optionComboLabel, parseArtworkSplits } from '@/lib/artwork-options'
import { resolveLineEntry } from '@/lib/artwork-slots'
import type { TaskLibraryState } from '@/lib/artwork-library-types'

export async function libraryStateFor(input: {
  storeId: string | null; shopifyProductId: string | null; templateId: string | null
  variantOptions?: string | Record<string, unknown> | null; artworkSplits?: string | null
}): Promise<TaskLibraryState | null> {
  const { storeId, shopifyProductId, templateId } = input
  if (!storeId || !shopifyProductId || !templateId) return null
  const key = toRouteKey(storeId, shopifyProductId)
  const [entries, splitsJson] = await Promise.all([
    prisma.artworkEntry.findMany({
      where: { storeId, shopifyProductId, printTemplateId: templateId },
      select: { id: true, printTemplateId: true, optionKey: true, status: true, fields: true },
    }),
    input.artworkSplits !== undefined
      ? Promise.resolve(input.artworkSplits)
      : prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } }, select: { artworkSplits: true } }).then(p => p?.artworkSplits ?? null),
  ])
  const e = resolveLineEntry(entries, templateId, input.variantOptions ?? null, parseArtworkSplits(splitsJson))
  if (!e) return { key, entryId: null, status: 'NONE', label: 'Thiếu', optionKey: '', optionLabel: null, layers: [] }
  const status = e.status as EntryStatus
  const label = status === 'READY' ? 'Sẵn sàng' : status === 'QUEUED' || status === 'PARSING' ? 'Đang đọc' : 'Thiếu'
  const layers = parseFields(e.fields).map(f => ({ field: f.field, layer: f.layer, fit: f.fit, ...(f.maxChars ? { maxChars: f.maxChars } : {}) }))
  return { key, entryId: e.id, status, label, optionKey: e.optionKey, optionLabel: e.optionKey ? optionComboLabel(e.optionKey) : null, layers }
}
