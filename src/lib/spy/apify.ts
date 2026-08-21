export const ACTOR_ID = 'curious_coder~facebook-ads-library-scraper'
const BASE = 'https://api.apify.com/v2'

function token(): string {
  const t = process.env.APIFY_TOKEN
  if (!t) throw new Error('APIFY_TOKEN not set')
  return t
}

export async function startActorRun(input: object): Promise<{ runId: string; datasetId: string }> {
  const res = await fetch(`${BASE}/acts/${ACTOR_ID}/runs?token=${token()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Apify start run failed: ${res.status}`)
  const json = await res.json()
  return { runId: json.data.id, datasetId: json.data.defaultDatasetId }
}

export async function getRunStatus(runId: string): Promise<string> {
  const res = await fetch(`${BASE}/actor-runs/${runId}?token=${token()}`)
  if (!res.ok) throw new Error(`Apify run status failed: ${res.status}`)
  const json = await res.json()
  return json.data.status
}

export async function getDatasetItems(datasetId: string): Promise<any[]> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/items?clean=true&token=${token()}`)
  if (!res.ok) throw new Error(`Apify dataset fetch failed: ${res.status}`)
  return res.json()
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
    if (Date.now() - start > timeoutMs) throw new Error('Apify run timeout')
    await new Promise(r => setTimeout(r, intervalMs))
  }
}
