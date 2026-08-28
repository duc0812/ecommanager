import { crawlTrackingPagesHeadless, type HeadlessCrawlResult } from './crawl-headless'

export type CrawlResult = HeadlessCrawlResult

export type ParcelwillCrawlContext = {
  storefrontBase: string
  myshopifyDomain: string
}

export async function crawlParcelwill(
  numbers: string[],
  context: ParcelwillCrawlContext,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, CrawlResult>> {
  const base = context.storefrontBase.replace(/\/$/, '')
  return crawlTrackingPagesHeadless(
    numbers.map(trackingNumber => ({
      trackingNumber,
      trackingUrl: `${base}/apps/trackingorder?nums=${encodeURIComponent(trackingNumber)}`,
    })),
    onProgress,
  )
}
