import { syncParcelPanelTracking, type ParcelPanelSyncResult } from './parcelpanel-sync'
import { getParcelPanelApiKey } from './parcelpanel-config'

// ParcelPanel is read under the key of the store whose orders are being checked. A store with no key is skipped
// and logged, so it is never looked up in another store's ParcelPanel account.
export async function syncParcelPanelForStore(
  store: { storeId: string; shop: string },
  opts: { includeDelivered?: boolean; sinceDays?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<ParcelPanelSyncResult> {
  const apiKey = await getParcelPanelApiKey(store.storeId)
  if (!apiKey) {
    console.log(`[parcelpanel] ${store.shop}: no ParcelPanel API key for this store; skipped`)
    return { ordersChecked: 0, shipmentsUpdated: 0, delivered: 0, errors: [] }
  }
  return syncParcelPanelTracking({ apiKey, storeId: store.storeId, ...opts })
}
