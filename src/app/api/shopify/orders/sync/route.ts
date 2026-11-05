import { NextRequest, NextResponse } from 'next/server'
import { getStoreConnection, listConnectedStores, tryStoreConnection, type ConnectedStore } from '@/lib/store-connections'
import { connectionFailureResponse } from '@/lib/store-connection-response'
import { forEachConnectedStore, okResults, type StoreRunResult } from '@/lib/store-jobs'
import { StoreOrderSyncError, syncStoreOrders, type StoreOrderSyncResult } from '@/lib/shopify-order-sync'
import { forbidden } from '@/lib/api-auth'
import { requireScope } from '@/lib/order-scope'

const NOT_CONNECTED = { error: 'Not connected to Shopify. Go to /setup and connect Shopify first.', status: 401 }

// "#LIT4665" and "LIT4665" belong to the store whose orderPrefix is LIT. With a single connected store
// there is nothing to choose, so a name without letters (or with another prefix) still goes to it.
function storeForOrderName(stores: ConnectedStore[], orderName: string): ConnectedStore | null {
  if (stores.length === 1) return stores[0]
  const prefix = orderName.match(/^#?([A-Za-z]+)/)?.[1]?.toUpperCase()
  if (!prefix) return null
  const matches = stores.filter(s => s.orderPrefix?.toUpperCase() === prefix)
  return matches.length === 1 ? matches[0] : null
}

export async function POST(req: NextRequest) {
  const scope = await requireScope(req, 'fulfillment_orders')
  if ('error' in scope) return scope.error
  const body = await req.json().catch(() => ({}))
  const fromOrderName = typeof body.fromOrderName === 'string' && body.fromOrderName.trim()
    ? body.fromOrderName.trim()
    : null
  const storeId = typeof body.storeId === 'string' && body.storeId.trim() ? body.storeId.trim() : null

  // A caller limited to some stores syncs those stores only: naming another one is refused, naming none means all of its own.
  const own = scope.storeIds
  if (own && storeId && !own.includes(storeId)) return forbidden('Bạn không có quyền xem store này.')
  if (own && own.length === 0) return forbidden('Bạn chưa được giao store nào.')
  const stores = (await listConnectedStores()).filter(s => !own || own.includes(s.id))
  let targets = stores
  if (storeId) {
    targets = stores.filter(s => s.id === storeId)
    if (targets.length === 0) {
      const { conn, error } = await tryStoreConnection(() => getStoreConnection(storeId))
      if (!conn) return connectionFailureResponse(error, NOT_CONNECTED)
      return NextResponse.json({ error: NOT_CONNECTED.error }, { status: NOT_CONNECTED.status })
    }
  } else if (fromOrderName && stores.length > 0) {
    const target = storeForOrderName(stores, fromOrderName)
    if (!target) {
      return NextResponse.json({ error: 'Cannot tell which store fromOrderName belongs to. Pass storeId.' }, { status: 400 })
    }
    targets = [target]
  }
  if (targets.length === 0) return NextResponse.json({ error: NOT_CONNECTED.error }, { status: NOT_CONNECTED.status })

  const failures = new Map<string, StoreOrderSyncError>()
  const results = await forEachConnectedStore('order-sync', async (_conn, store) => {
    try {
      return await syncStoreOrders(store.id, { fromOrderName })
    } catch (e) {
      if (e instanceof StoreOrderSyncError) failures.set(store.id, e)
      throw e
    }
  }, { storeIds: targets.map(s => s.id) })

  return respond(results, failures, fromOrderName)
}

function respond(results: StoreRunResult<StoreOrderSyncResult>[], failures: Map<string, StoreOrderSyncError>, fromOrderName: string | null) {
  const many = results.length > 1
  const label = (shop: string, text: string) => (many ? `${shop}: ${text}` : text)

  const counted: StoreOrderSyncResult[] = []
  const errors: string[] = []
  for (const r of results) {
    if (r.ok) {
      counted.push(r.result)
      errors.push(...r.result.errors.map(e => label(r.shop, e)))
      continue
    }
    const partial = failures.get(r.storeId)?.result
    if (partial) {
      counted.push(partial)
      errors.push(...partial.errors.map(e => label(r.shop, e)))
    } else {
      errors.push(label(r.shop, r.error))
    }
  }

  const sum = (pick: (r: StoreOrderSyncResult) => number) => counted.reduce((total, r) => total + pick(r), 0)
  const projectNames = Array.from(new Set(counted.map(r => r.projectName)))
  const payload = {
    totalSynced: sum(r => r.totalSynced),
    withUnmappedSku: sum(r => r.withUnmappedSku),
    errors,
    projectId: counted[0]?.projectId ?? null,
    projectName: projectNames.length > 0 ? projectNames.join(', ') : null,
    fromOrderName,
    skippedBeforeFromOrder: sum(r => r.skippedBeforeFromOrder),
    stores: results,
  }

  const ran = results.filter(r => r.ok || !r.skipped)
  if (ran.length === 0) {
    return NextResponse.json({ ...payload, error: results[0].ok ? 'Order sync is already running' : results[0].error }, { status: 409 })
  }
  if (okResults(ran).length === 0) {
    // One store failing on its own settings keeps the status that failure always had; any other failure is a bad gateway.
    const only = ran.length === 1 ? failures.get(ran[0].storeId) : undefined
    return NextResponse.json({ ...payload, error: errors[0] }, { status: only?.status ?? 502 })
  }
  return NextResponse.json(payload)
}
