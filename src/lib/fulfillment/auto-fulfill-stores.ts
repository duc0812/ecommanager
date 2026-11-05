import { listConnectedStores } from '@/lib/store-connections'
import { forEachConnectedStore, mergeStoreResults, type StoreRunResult } from '@/lib/store-jobs'
import { type SheetConfig } from './auto-fulfill-sheets'
import {
  orderNameHasPrefix, readAutoFulfillSheets, runAutoFulfill, sheetsForStore,
  type AutoFulfillStage, type AutoFulfillSummary, type OrderResultRow,
} from './auto-fulfill'

export const AUTO_FULFILL_SUM_KEYS = ['ordersChecked', 'fulfilled', 'tooRecent', 'alreadyFulfilled', 'notFound', 'needsManual', 'errored'] as const

// Every connected store, one after the other, over the same sheets: each sheet is downloaded once and a
// store only sees the rows whose order name carries its prefix, so no store asks Shopify about another
// store's orders. A row that no connected store owns is reported once as an error and fulfils nothing.
// `summary` is the totals over the stores that worked (null when none did), with the sheet download
// errors and the unowned rows added once.
export async function runAutoFulfillForStores(opts: {
  sheets: SheetConfig[]
  minAgeDays: number
  apply: boolean
  onProgress?: (shop: string, done: number, total: number) => void
  onStage?: (shop: string | null, stage: AutoFulfillStage, done: number, total: number) => void
}): Promise<{ results: StoreRunResult<AutoFulfillSummary>[]; summary: AutoFulfillSummary | null }> {
  const connected = await listConnectedStores()
  const read = await readAutoFulfillSheets(opts.sheets, (stage, done, total) => opts.onStage?.(null, stage, done, total))

  const results = await forEachConnectedStore('auto-fulfill', (conn, store) => runAutoFulfill({
    shop: conn.shop, accessToken: conn.token, storeId: conn.storeId,
    sheets: [], sheetData: sheetsForStore(read.sheets, store.orderPrefix),
    minAgeDays: opts.minAgeDays, apply: opts.apply,
    onProgress: (done, total) => opts.onProgress?.(conn.shop, done, total),
    onStage: (stage, done, total) => opts.onStage?.(conn.shop, stage, done, total),
  }))

  const merged = mergeStoreResults(results, { sum: [...AUTO_FULFILL_SUM_KEYS], concat: ['rows'] })
  if (!merged) return { results, summary: null }

  const unowned: OrderResultRow[] = []
  const seen = new Set<string>()
  for (const sheet of read.sheets) {
    for (const base of Array.from(sheet.groups.keys())) {
      if (seen.has(base) || connected.some(s => orderNameHasPrefix(base, s.orderPrefix))) continue
      seen.add(base)
      unowned.push({ baseOrder: base, status: 'error', trackings: [], fulfilledLines: 0, message: 'Mã đơn không có tiền tố của store nào đang kết nối' })
    }
  }
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
