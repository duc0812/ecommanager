import { fetchOrderFulfillmentsByName, updateFulfillmentTracking } from '@/lib/shopify-orders'
import { detectLastMileCarrier } from './lastmile-carrier'

export type LastMileMapping = { orderName: string; number: string }

export type PushRow = {
  orderName: string
  number: string
  status: 'pushed' | 'already_set' | 'not_found' | 'split_skipped' | 'error'
  fulfillments?: number
  message?: string
}

export type PushResult = {
  orders: number
  pushed: number
  alreadySet: number
  notFound: number
  skipped: number
  errored: number
  rows: PushRow[]
}

// linkMode 'store' → carrier "Other" + the store's own ParcelPanel tracking page
// (branded, keeps customers on-site). 'carrier' → detect the real carrier so
// Shopify links to the carrier site (e.g. USPS).
export type LinkMode = 'store' | 'carrier'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// "#LIT2499_1" / "#LIT2867_1M" / "#LIT2515R1_2" → order name "#LIT2499" etc.
// (strip the sub-order suffix our lineKey convention adds).
export function normalizeOrderName(raw: string): string {
  return raw.trim().replace(/^\\+/, '').replace(/_[A-Za-z0-9]+$/, '')
}

function buildTrackingInput(number: string, storeBase: string, mode: LinkMode) {
  if (mode === 'store') {
    return { company: 'Other', number, url: `${storeBase.replace(/\/$/, '')}/apps/trackingorder?nums=${encodeURIComponent(number)}` }
  }
  const carrier = detectLastMileCarrier(number)
  return { company: carrier.company, number, ...(carrier.url ? { url: carrier.url } : {}) }
}

export function parseMappingText(text: string): LastMileMapping[] {
  const out: LastMileMapping[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    // split on tab / comma / multiple spaces
    const parts = t.split(/\t|,|\s{2,}|\s+/).map(s => s.trim()).filter(Boolean)
    if (parts.length < 2) continue
    const orderName = parts[0]
    const number = parts[parts.length - 1]
    if (!/^#?\w/.test(orderName) || !/\w/.test(number)) continue
    if (/order\s*number/i.test(orderName)) continue // skip header row
    out.push({ orderName, number })
  }
  return out
}

export async function pushLastMileToShopify(opts: {
  shop: string
  accessToken: string
  storeBase: string
  mapping: LastMileMapping[]
  notifyCustomer?: boolean
  linkMode?: LinkMode
  onProgress?: (done: number, total: number) => void
  onRow?: (row: PushRow, done: number, total: number) => void
}): Promise<PushResult> {
  // Group by order name; collect distinct last-mile numbers per order.
  const byOrder = new Map<string, string[]>()
  for (const r of opts.mapping) {
    const name = normalizeOrderName(r.orderName)
    const number = r.number.trim()
    if (!name || !number) continue
    const arr = byOrder.get(name)
    if (arr) { if (!arr.includes(number)) arr.push(number) }
    else byOrder.set(name, [number])
  }

  const entries = Array.from(byOrder.entries())
  const rows: PushRow[] = []
  const total = entries.length
  let done = 0
  for (const [orderName, numbers] of entries) {
    // A split shipment (several different last-mile numbers) needs per-fulfillment
    // matching we don't do automatically — flag it for manual handling.
    if (numbers.length > 1) {
      rows.push({ orderName, number: numbers.join(', '), status: 'split_skipped', message: 'Nhiều số last-mile — cần xử tay' })
      done++; opts.onProgress?.(done, total); opts.onRow?.(rows[rows.length - 1], done, total); continue
    }
    const number = numbers[0]
    try {
      const found = await fetchOrderFulfillmentsByName(opts.shop, opts.accessToken, orderName)
      const order = found.find(o => o.orderName.replace(/^#/, '') === orderName.replace(/^#/, '')) ?? found[0]
      if (!order || order.fulfillments.length === 0) {
        rows.push({ orderName, number, status: 'not_found', message: 'Không thấy order/fulfillment trên Shopify' })
        done++; opts.onProgress?.(done, total); opts.onRow?.(rows[rows.length - 1], done, total); continue
      }
      const input = buildTrackingInput(number, opts.storeBase, opts.linkMode ?? 'store')
      let pushed = 0
      let alreadySet = 0
      const errs: string[] = []
      for (const f of order.fulfillments) {
        // Already carries this exact number → skip (no re-push, no duplicate customer email).
        if (f.trackingNumbers.includes(number)) { alreadySet++; continue }
        const r = await updateFulfillmentTracking(opts.shop, opts.accessToken, f.id, input, opts.notifyCustomer ?? false)
        if (r.ok) pushed++
        else errs.push(r.error ?? 'unknown')
        await sleep(300)
      }
      if (pushed > 0) rows.push({ orderName, number, status: 'pushed', fulfillments: pushed, message: errs.length ? `1 phần lỗi: ${errs.join('; ')}` : (alreadySet ? `${alreadySet} ful đã đúng sẵn` : undefined) })
      else if (errs.length > 0) rows.push({ orderName, number, status: 'error', message: errs.join('; ') })
      else rows.push({ orderName, number, status: 'already_set', message: 'Đã đúng số last-mile — bỏ qua' })
    } catch (e: any) {
      rows.push({ orderName, number, status: 'error', message: e?.message ?? 'lỗi' })
    }
    done++; opts.onProgress?.(done, total); opts.onRow?.(rows[rows.length - 1], done, total)
    await sleep(250)
  }

  return {
    orders: total,
    pushed: rows.filter(r => r.status === 'pushed').length,
    alreadySet: rows.filter(r => r.status === 'already_set').length,
    notFound: rows.filter(r => r.status === 'not_found').length,
    skipped: rows.filter(r => r.status === 'split_skipped').length,
    errored: rows.filter(r => r.status === 'error').length,
    rows,
  }
}
