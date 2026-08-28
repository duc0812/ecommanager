import { chromium, type Browser, type Page } from 'playwright'
import { detectInternalStatus, type TrackingCheckpoint } from './tracking-status'

// Resolves delivery status via parcelsapp.com — the one universal source proven
// to follow China-line → last-mile handoffs (Jomall → China Post → USPS) that
// ParcelPanel / 17track / Cainiao miss. parcelsapp guards against bots with a
// "RELOAD" response, defeated by hiding the automation flags below.

export type ParcelsappResult = {
  trackingNumber: string
  ok: boolean
  error?: string
  status: string
  carrierChain: string[]
  lastMileCarrier: string | null
  lastMileTrackingNumber: string | null
  checkpoints: TrackingCheckpoint[]
  lastCheckpointAt: Date | null
}

const SUB_STATUS_MAP: Record<string, string> = {
  delivered: 'DELIVERED',
  transit: 'IN_TRANSIT',
  pickup: 'OUT_FOR_DELIVERY',
  'out for delivery': 'OUT_FOR_DELIVERY',
  info_received: 'INFO_RECEIVED',
  'info received': 'INFO_RECEIVED',
  exception: 'EXCEPTION',
  expired: 'EXPIRED',
  'attempt fail': 'FAILED_ATTEMPT',
  'failed attempt': 'FAILED_ATTEMPT',
}

function normalizeStatus(subStatus: string | undefined, checkpoints: TrackingCheckpoint[]): string {
  const sub = subStatus?.toLowerCase().trim()
  if (sub && SUB_STATUS_MAP[sub]) return SUB_STATUS_MAP[sub]
  if (checkpoints.length === 0) return 'PENDING'
  return detectInternalStatus(checkpoints.slice(0, 3).map(c => c.desc))
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

function parsePayload(trackingNumber: string, json: any): ParcelsappResult {
  const ship = json?.shipments?.[0] ?? json
  const states: any[] = Array.isArray(ship?.states) ? ship.states : []
  const checkpoints: TrackingCheckpoint[] = states.map(s => ({
    time: s.date ?? '',
    desc: (s.status ?? '').trim(),
    status: detectInternalStatus([s.status ?? '']),
  }))
  const carrierChain: string[] = Array.isArray(ship?.carriers) ? ship.carriers.filter(Boolean) : []
  const nextIds: string[] = Array.isArray(ship?.next_tracking_ids) ? ship.next_tracking_ids.filter(Boolean) : []
  return {
    trackingNumber,
    ok: true,
    status: normalizeStatus(ship?.sub_status, checkpoints),
    carrierChain,
    lastMileCarrier: carrierChain.length > 0 ? carrierChain[carrierChain.length - 1] : null,
    // The number the final leg is tracked under (China-line hands the parcel to
    // the next tracking id, which the destination post/USPS scans against).
    lastMileTrackingNumber: nextIds.length > 0 ? nextIds[nextIds.length - 1] : null,
    checkpoints,
    lastCheckpointAt: parseDate(states[0]?.date),
  }
}

async function fetchOne(page: Page, trackingNumber: string): Promise<ParcelsappResult> {
  let resolved: any = null
  let sawReload = false
  const handler = async (res: any) => {
    try {
      if (!/parcelsapp\.com\/api/i.test(res.url())) return
      const body = await res.text().catch(() => '')
      if (body.includes('"error"') && body.includes('RELOAD')) { sawReload = true; return }
      if (body.includes('"states"') || body.includes('"carriers"')) resolved = JSON.parse(body)
    } catch {}
  }
  page.on('response', handler)
  try {
    await page.goto(`https://parcelsapp.com/en/tracking/${trackingNumber}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    for (let i = 0; i < 20 && !resolved; i++) {
      await page.waitForTimeout(1000)
      if (!resolved && sawReload && i === 6) { sawReload = false; await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}) }
    }
  } catch (e: any) {
    page.off('response', handler)
    return emptyResult(trackingNumber, e?.message ?? 'navigation failed')
  }
  page.off('response', handler)
  if (!resolved) return emptyResult(trackingNumber, sawReload ? 'blocked (RELOAD)' : 'no data returned')
  return parsePayload(trackingNumber, resolved)
}

function emptyResult(trackingNumber: string, error: string): ParcelsappResult {
  return { trackingNumber, ok: false, error, status: 'PENDING', carrierChain: [], lastMileCarrier: null, lastMileTrackingNumber: null, checkpoints: [], lastCheckpointAt: null }
}

export async function crawlParcelsApp(
  numbers: string[],
  onResult?: (num: string, result: ParcelsappResult) => Promise<void> | void,
): Promise<Map<string, ParcelsappResult>> {
  const results = new Map<string, ParcelsappResult>()
  if (numbers.length === 0) return results

  let browser: Browser | null = null
  try {
    browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1366, height: 900 },
    })
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      ;(window as any).chrome = { runtime: {} }
    })
    const page = await context.newPage()
    // Warm the session so the first tracking request isn't rejected with RELOAD.
    await page.goto('https://parcelsapp.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(1500)

    let consecutiveFailures = 0
    for (const num of numbers) {
      let r = await fetchOne(page, num)
      if (!r.ok) {
        // brief backoff + one retry — most failures are transient RELOAD / slow polling
        await page.waitForTimeout(3000)
        r = await fetchOne(page, num)
      }
      if (!r.ok) {
        consecutiveFailures++
        // Repeated failures usually mean rate-limiting: cool down and re-warm the session.
        if (consecutiveFailures >= 3) {
          await page.waitForTimeout(45000)
          await page.goto('https://parcelsapp.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
          await page.waitForTimeout(2000)
          consecutiveFailures = 0
        }
      } else {
        consecutiveFailures = 0
      }
      results.set(num, r)
      await onResult?.(num, r)          // persist incrementally so progress survives interruption
      await page.waitForTimeout(1500)
    }
  } finally {
    await browser?.close().catch(() => {})
  }
  return results
}
