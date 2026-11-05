import { prisma } from '@/lib/db'
import { listConnectedStores, type ConnectedStore } from '@/lib/store-connections'
import { forEachConnectedStore, mergeStoreResults, type StoreRunResult } from '@/lib/store-jobs'
import { orderPrefixOf, storeForOrderName, storesWithPrefix } from '@/lib/order-prefix'
import { type SheetConfig } from './auto-fulfill-sheets'
import {
  readAutoFulfillSheets, runAutoFulfill, trackingUrlFor,
  type AutoFulfillStage, type AutoFulfillSummary, type OrderResultRow, type SheetData,
} from './auto-fulfill'

export { trackingUrlFor }

export const AUTO_FULFILL_SUM_KEYS = ['ordersChecked', 'fulfilled', 'tooRecent', 'alreadyFulfilled', 'notFound', 'needsManual', 'errored'] as const

const NO_STORE = 'Mã đơn không có tiền tố của store nào đang kết nối'

// Why a row has no store to run under. It is reported with this and fulfils nothing.
function whyNoStore(base: string, everyStore: Array<{ shop: string; orderPrefix: string | null; enabled: boolean }>): string {
  const prefix = orderPrefixOf(base)
  const claimed = storesWithPrefix(prefix, everyStore)
  if (claimed.length > 1) return `Tiền tố ${prefix} khớp nhiều store, không biết đơn thuộc store nào`
  if (claimed.length === 0) return NO_STORE
  return claimed[0].enabled ? `Store ${claimed[0].shop} chưa kết nối, không fulfill đơn này` : `Store ${claimed[0].shop} đang tắt, không fulfill đơn này`
}

// Every connected store, one after the other, over the same sheets. Each sheet is downloaded once and every order
// in it goes to the one store its prefix names (storeForOrderName), so a store only asks Shopify about its own
// orders and uses its own token and tracking page. A row that no connected store owns (no such prefix, a store
// that is off or disconnected, a prefix two stores claim) is reported once as an error and fulfils nothing.
// `summary` is the totals over the stores that worked (null when none did), with the sheet download errors and
// the unowned rows added once. One store failing is recorded on that store and does not stop the next.
export async function runAutoFulfillAllStores(opts: {
  sheets: SheetConfig[]
  minAgeDays: number
  apply: boolean
  now?: Date
  onProgress?: (shop: string, done: number, total: number) => void
  onStage?: (shop: string | null, stage: AutoFulfillStage, done: number, total: number) => void
}): Promise<{ results: StoreRunResult<AutoFulfillSummary>[]; summary: AutoFulfillSummary | null }> {
  const connected = await listConnectedStores()
  const read = await readAutoFulfillSheets(opts.sheets, (stage, done, total) => opts.onStage?.(null, stage, done, total))

  const ownerOf = new Map<string, ConnectedStore>()
  const unownedBases: string[] = []
  const seen = new Set<string>()
  for (const sheet of read.sheets) {
    for (const base of Array.from(sheet.groups.keys())) {
      if (seen.has(base)) continue
      seen.add(base)
      const store = storeForOrderName(base, connected)
      if (store) ownerOf.set(base, store)
      else unownedBases.push(base)
    }
  }
  const sheetsOf = (storeId: string): SheetData[] => read.sheets.map(sheet => ({
    ...sheet,
    groups: new Map(Array.from(sheet.groups).filter(([base]) => ownerOf.get(base)?.id === storeId)),
  }))

  const results = await forEachConnectedStore('auto-fulfill', (conn, store) => runAutoFulfill({
    shop: conn.shop, accessToken: conn.token, storeId: conn.storeId, storeName: store.projectName ?? store.shop, trackingPageUrl: store.trackingPageUrl,
    sheets: [], sheetData: sheetsOf(store.id),
    minAgeDays: opts.minAgeDays, apply: opts.apply, now: opts.now,
    onProgress: (done, total) => opts.onProgress?.(conn.shop, done, total),
    onStage: (stage, done, total) => opts.onStage?.(conn.shop, stage, done, total),
  }))

  const merged = mergeStoreResults(results, { sum: [...AUTO_FULFILL_SUM_KEYS], concat: ['rows'] })
  if (!merged) return { results, summary: null }

  const everyStore = unownedBases.length ? await prisma.shopifyStore.findMany({ select: { shop: true, orderPrefix: true, enabled: true } }) : []
  const unowned: OrderResultRow[] = unownedBases.map(base => ({
    baseOrder: base, status: 'error', trackings: [], fulfilledLines: 0, message: whyNoStore(base, everyStore),
  }))
  return {
    results,
    summary: {
      ...merged,
      ordersChecked: merged.ordersChecked + unowned.length,
      errored: merged.errored + unowned.length + read.errorRows.length,
      rows: [...read.errorRows, ...unowned, ...merged.rows],
    },
  }
}
