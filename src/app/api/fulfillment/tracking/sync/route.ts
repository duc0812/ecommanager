import { NextRequest } from 'next/server'
import { forEachConnectedStore, okResults } from '@/lib/store-jobs'
import { storeRunsResponse } from '@/lib/store-run-response'
import { syncStoreTracking, clampTrackingDays } from '@/lib/tracking/tracking-sync'

export async function POST(req: NextRequest) {
  const days = clampTrackingDays(req.nextUrl.searchParams.get('days'))

  const projectNames = new Map<string, string>()
  const unlinked = new Set<string>()
  const results = await forEachConnectedStore('tracking-sync', async (conn, store) => {
    if (!store.projectId || !store.projectName) {
      unlinked.add(store.id)
      throw new Error('Store not linked to a project. Assign it in /setup/projects.')
    }
    projectNames.set(store.id, store.projectName)
    return syncStoreTracking({ shop: conn.shop, accessToken: conn.token, storeId: conn.storeId, days })
  })

  return storeRunsResponse(results, {
    sum: ['ordersProcessed', 'shipmentCount', 'withTracking', 'withoutTracking', 'fulfillmentStatusUpdated'],
    concat: ['errors'],
  }, {
    notConnected: { error: 'Not connected to Shopify. Go to /setup and connect Shopify first.', status: 401 },
    // The only store being unlinked is a settings problem, as it always was.
    failureStatus: results.length === 1 && unlinked.has(results[0].storeId) ? 400 : 502,
    extra: (_merged, all) => ({
      projectName: Array.from(new Set(okResults(all).map(r => projectNames.get(r.storeId)))).join(', '),
    }),
    rejectMerged: merged => (merged.errors.length > 0 && merged.shipmentCount === 0 ? merged.errors[0] : null),
  })
}
