import { forEachConnectedStore } from '@/lib/store-jobs'
import { storeRunsResponse } from '@/lib/store-run-response'
import { normalizeOpenOrderStatuses } from '@/lib/order-normalize'

// Manual trigger for the same normalization the daily cron runs.
export async function POST() {
  const results = await forEachConnectedStore('order-normalize', (conn) =>
    normalizeOpenOrderStatuses({ shop: conn.shop, accessToken: conn.token, storeId: conn.storeId }))
  return storeRunsResponse(results, { sum: ['ordersOpen', 'fulfillmentUpdated', 'pipelineFulfilled'], concat: ['errors'] }, {
    notConnected: { error: 'Not connected to Shopify.', status: 400 },
  })
}
