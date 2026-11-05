import { NextRequest } from 'next/server'
import { forEachConnectedStore } from '@/lib/store-jobs'
import { storeRunsResponse } from '@/lib/store-run-response'
import { normalizeOpenOrderStatuses } from '@/lib/order-normalize'
import { requireScope } from '@/lib/order-scope'

// Manual trigger for the same normalization the daily cron runs. A caller limited to some stores runs it for those stores only.
export async function POST(req: NextRequest) {
  const scope = await requireScope(req, 'fulfillment_orders')
  if ('error' in scope) return scope.error
  const results = await forEachConnectedStore('order-normalize', (conn) =>
    normalizeOpenOrderStatuses({ shop: conn.shop, accessToken: conn.token, storeId: conn.storeId }), scope.storeIds ? { storeIds: scope.storeIds } : {})
  return storeRunsResponse(results, { sum: ['ordersOpen', 'fulfillmentUpdated', 'pipelineFulfilled'], concat: ['errors'] }, {
    notConnected: { error: 'Not connected to Shopify.', status: 400 },
  })
}
