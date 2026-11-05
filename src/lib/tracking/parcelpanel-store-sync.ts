import { listConnectedStores, type ConnectedStore, type StoreConnection } from '@/lib/store-connections'
import { StoreJobSkipped, forEachConnectedStore, type StoreRunResult } from '@/lib/store-jobs'
import { syncParcelPanelTracking, type ParcelPanelSyncResult } from './parcelpanel-sync'
import { getParcelPanelApiKey } from './parcelpanel-config'

const NO_KEY = 'chưa có ParcelPanel API key của store này, bỏ qua'

// ParcelPanel is read under the key of the store whose orders are being checked, never under another store's account.
export async function syncParcelPanelForStore(
  store: { storeId: string },
  opts: { includeDelivered?: boolean; sinceDays?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<ParcelPanelSyncResult> {
  const apiKey = await getParcelPanelApiKey(store.storeId)
  if (!apiKey) throw new StoreJobSkipped(NO_KEY)
  return syncParcelPanelTracking({ apiKey, storeId: store.storeId, ...opts })
}

export async function partitionByParcelPanelKey(): Promise<{ keyed: ConnectedStore[]; keyless: ConnectedStore[] }> {
  const keyed: ConnectedStore[] = []
  const keyless: ConnectedStore[] = []
  for (const store of await listConnectedStores()) (await getParcelPanelApiKey(store.id) ? keyed : keyless).push(store)
  return { keyed, keyless }
}

/**
 * Runs a job for every connected store that has a ParcelPanel key. A store without one is logged and reported as skipped,
 * and its Shopify connection is never opened (ParcelPanel does not need it, and opening it can mint a token).
 */
export async function forEachParcelPanelStore<T>(job: string, fn: (conn: StoreConnection, store: ConnectedStore) => Promise<T>): Promise<StoreRunResult<T>[]> {
  const { keyed, keyless } = await partitionByParcelPanelKey()
  for (const store of keyless) console.log(`[parcelpanel] ${store.shop}: no ParcelPanel API key for this store; skipped`)
  const ran = keyed.length > 0 ? await forEachConnectedStore(job, fn, { storeIds: keyed.map(s => s.id) }) : []
  return [...ran, ...keyless.map((store): StoreRunResult<T> => ({ storeId: store.id, shop: store.shop, ok: false, skipped: true, error: NO_KEY }))]
}
