import { chromium, type Browser, type Page } from 'playwright'
import { detectInternalStatus, type TrackingCheckpoint } from './tracking-status'

export type HeadlessTrackingTarget = {
  trackingNumber: string
  trackingUrl: string
}

export type HeadlessCrawlResult = {
  trackingNumber: string
  ok: boolean
  error?: string
  status?: string
  checkpoints?: TrackingCheckpoint[]
  lastCheckpointAt?: Date | null
}

const STATUS_SELECTORS = [
  '[aria-current="step"]',
  '[data-current="true"]',
  '[class*="current"][class*="status"]',
  '[class*="active"][class*="status"]',
  '[class*="shipment-status"]',
  '[class*="tracking-status"]',
  '[class*="track-status"]',
]

const EVENT_SELECTORS = [
  '[class*="checkpoint"]',
  '[class*="tracking-event"]',
  '[class*="tracking-detail"] li',
  '[class*="track-info"] li',
  '[class*="timeline"] li',
  '[class*="history"] li',
]

async function collectVisibleTexts(page: Page, selectors: string[], maxLength: number): Promise<string[]> {
  const values: string[] = []
  for (const selector of selectors) {
    const texts = await page.locator(selector).allInnerTexts().catch(() => [])
    for (const text of texts) {
      const compact = text.replace(/\s+/g, ' ').trim()
      if (compact.length >= 3 && compact.length <= maxLength) values.push(compact)
    }
  }
  return Array.from(new Set(values))
}

function checkpointFromText(text: string): TrackingCheckpoint {
  const match = text.match(
    /(?:\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})(?:[ T,]+\d{1,2}:\d{2}(?::\d{2})?)?/,
  )
  const time = match?.[0] ?? ''
  const desc = time ? text.replace(time, '').replace(/^[\s,|:-]+|[\s,|:-]+$/g, '') : text
  return { time, desc: desc || text, status: detectInternalStatus([text]) }
}

function parseCheckpointDate(raw: string): Date | null {
  if (!raw) return null
  const parsed = new Date(raw.replace(' ', 'T'))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

async function crawlOne(page: Page, target: HeadlessTrackingTarget): Promise<HeadlessCrawlResult> {
  try {
    await page.goto(target.trackingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(1500)

    const bodyText = await page.locator('body').innerText({ timeout: 15000 })
    if (!bodyText.trim()) return { trackingNumber: target.trackingNumber, ok: false, error: 'tracking page rendered no text' }
    if (/captcha|verify you are human|access denied|cloudflare ray id/i.test(bodyText)) {
      return { trackingNumber: target.trackingNumber, ok: false, error: 'tracking page blocked headless access' }
    }

    const currentSignals = await collectVisibleTexts(page, STATUS_SELECTORS, 160)
    const eventTexts = await collectVisibleTexts(page, EVENT_SELECTORS, 500)
    const checkpoints = eventTexts.slice(0, 50).map(checkpointFromText)
    const checkpointSignals = checkpoints.slice(0, 3).map(checkpoint => checkpoint.desc)
    // Without checkpoints, the page body is untrustworthy: status steppers render
    // every stage label ("Out for Delivery", "Delivered") even for unscanned parcels.
    const status = checkpoints.length > 0
      ? detectInternalStatus([...currentSignals, ...checkpointSignals], bodyText)
      : detectInternalStatus(currentSignals)

    return {
      trackingNumber: target.trackingNumber,
      ok: true,
      status,
      checkpoints,
      lastCheckpointAt: checkpoints.length > 0 ? parseCheckpointDate(checkpoints[0].time) : null,
    }
  } catch (error: any) {
    return { trackingNumber: target.trackingNumber, ok: false, error: error?.message ?? 'headless crawl failed' }
  }
}

export async function crawlTrackingPagesHeadless(
  targets: HeadlessTrackingTarget[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, HeadlessCrawlResult>> {
  const results = new Map<string, HeadlessCrawlResult>()
  if (targets.length === 0) return results

  let browser: Browser | null = null
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      locale: 'en-US',
    })
    const page = await context.newPage()
    let done = 0
    for (const target of targets) {
      const result = await crawlOne(page, target)
      results.set(target.trackingNumber, result)
      done++
      onProgress?.(done, targets.length)
      await page.waitForTimeout(500)
    }
  } finally {
    await browser?.close().catch(() => {})
  }
  return results
}
