import { prisma } from '@/lib/db'

export const ACTOR_ID = 'curious_coder~facebook-ads-library-scraper'
export const APIFY_TOKEN_SETTING_KEY = 'spy.apify_token'
const BASE = 'https://api.apify.com/v2'
const REQUEST_TIMEOUT_MS = 30_000
const DATASET_PAGE_SIZE = 100

export async function getApifyToken(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: APIFY_TOKEN_SETTING_KEY } })
  const t = row?.value?.trim() || process.env.APIFY_TOKEN
  if (!t) throw new Error('APIFY_TOKEN not set')
  return t
}

function withTimeout(init: RequestInit = {}): RequestInit {
  return { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
}

export async function startActorRun(input: object): Promise<{ runId: string; datasetId: string }> {
  const res = await fetch(`${BASE}/acts/${ACTOR_ID}/runs?token=${await getApifyToken()}`, withTimeout({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }))
  if (!res.ok) throw new Error(`Apify start run failed: ${res.status}`)
  const json = await res.json()
  return { runId: json.data.id, datasetId: json.data.defaultDatasetId }
}

export async function getRunStatus(runId: string): Promise<string> {
  const res = await fetch(`${BASE}/actor-runs/${runId}?token=${await getApifyToken()}`, withTimeout())
  if (!res.ok) throw new Error(`Apify run status failed: ${res.status}`)
  const json = await res.json()
  return json.data.status
}

export async function abortActorRun(runId: string): Promise<void> {
  try {
    await fetch(`${BASE}/actor-runs/${runId}/abort?token=${await getApifyToken()}`, withTimeout({ method: 'POST' }))
  } catch (e) {
    console.error('[apify] abort failed for run', runId, e)
  }
}

// Pages through the dataset so a large run is never parsed as one JSON body.
export async function getDatasetItems(datasetId: string, opts: { maxItems?: number } = {}): Promise<any[]> {
  const token = await getApifyToken()
  const maxItems = opts.maxItems ?? 5000
  const items: any[] = []
  let offset = 0
  for (;;) {
    const limit = Math.min(DATASET_PAGE_SIZE, maxItems - items.length)
    if (limit <= 0) break
    const res = await fetch(`${BASE}/datasets/${datasetId}/items?clean=true&limit=${limit}&offset=${offset}&token=${token}`, withTimeout())
    if (!res.ok) throw new Error(`Apify dataset fetch failed: ${res.status}`)
    const page: any[] = await res.json()
    items.push(...page)
    if (page.length < limit) break
    offset += page.length
  }
  return items
}

const TERMINAL_OK = new Set(['SUCCEEDED'])
const TERMINAL_BAD = new Set(['FAILED', 'TIMED-OUT', 'ABORTED'])

export async function pollRunUntilDone(
  runId: string, opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const intervalMs = opts.intervalMs ?? 10_000
  const timeoutMs = opts.timeoutMs ?? 300_000
  const start = Date.now()
  for (;;) {
    const status = await getRunStatus(runId)
    if (TERMINAL_OK.has(status)) return status
    if (TERMINAL_BAD.has(status)) throw new Error(`Apify run ${status}`)
    if (Date.now() - start > timeoutMs) {
      // Stop the actor so it does not keep consuming credits for a result we will discard.
      await abortActorRun(runId)
      throw new Error('Apify run timeout')
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}
