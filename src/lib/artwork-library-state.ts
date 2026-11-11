import { prisma } from '@/lib/db'
import { toRouteKey } from '@/lib/product-profiles'
import { parseFields, type EntryStatus } from '@/lib/artwork-fields'
import { optionComboLabel, parseArtworkSplits } from '@/lib/artwork-options'
import { resolveLineEntry } from '@/lib/artwork-slots'
import type { TaskLibraryState } from '@/lib/artwork-library-types'
import type { FlatTextSpec } from '@/lib/flat-text-coverage'

export const LOCAL_LIBRARY_KEY = 'artwork_library_local_state'

export type LocalEntry = {
  id: string; storeId: string; shopifyProductId: string; printTemplateId: string; optionKey: string; status: string
  /** A PSD entry: the fields the customer has to fill. */
  fields?: string[]
  /** A flat-text entry: which lines each spec serves. */
  specs?: FlatTextSpec[]
}

export async function readLocalEntries(): Promise<LocalEntry[] | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: LOCAL_LIBRARY_KEY }, select: { value: true } })
  if (!row) return null
  try {
    const entries = JSON.parse(row.value)?.entries
    return Array.isArray(entries) ? entries : null
  } catch {
    return null
  }
}

function labelFor(status: EntryStatus): TaskLibraryState['label'] {
  return status === 'READY' ? 'Sẵn sàng' : status === 'QUEUED' || status === 'PARSING' ? 'Đang đọc' : 'Thiếu'
}

type LibraryInput = {
  storeId: string | null; shopifyProductId: string | null; templateId: string | null
  variantOptions?: string | Record<string, unknown> | null; artworkSplits?: string | null
}

/**
 * The state a task shows (owner 11-02: the checklist follows the local library, copied here by scripts/sync-library-state.py). A READY entry on this
 * server stands. Auto-render keeps reading libraryStateFor: a local entry has no PSD here, so it gets no entry id and no layers.
 */
export async function checklistLibraryState(input: LibraryInput): Promise<TaskLibraryState | null> {
  const state = await libraryStateFor(input)
  if (!state || state.status === 'READY') return state
  const local = await readLocalEntries()
  if (!local) return state
  const mine = local.filter(e => e.storeId === input.storeId && e.shopifyProductId === input.shopifyProductId)
  const e = resolveLineEntry(mine, input.templateId as string, input.variantOptions ?? null, parseArtworkSplits(input.artworkSplits ?? null))
  if (!e) return { key: state.key, entryId: null, status: 'NONE', label: 'Thiếu', optionKey: '', optionLabel: null, layers: [], source: 'LOCAL' }
  const status = e.status as EntryStatus
  return { key: state.key, entryId: null, status, label: labelFor(status), optionKey: e.optionKey, optionLabel: e.optionKey ? optionComboLabel(e.optionKey) : null, layers: [], source: 'LOCAL' }
}

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
  const label = labelFor(status)
  const layers = parseFields(e.fields).map(f => ({ field: f.field, layer: f.layer, fit: f.fit, ...(f.maxChars ? { maxChars: f.maxChars } : {}), ...(f.required !== undefined ? { required: f.required } : {}) }))
  return { key, entryId: e.id, status, label, optionKey: e.optionKey, optionLabel: e.optionKey ? optionComboLabel(e.optionKey) : null, layers }
}
