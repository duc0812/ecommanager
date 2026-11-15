// Local client for the Artwork Delivery API (src/app/api/design-studio/worker/delivery/*). Plain ESM, JSDoc types.

const BASE = '/api/design-studio/worker/delivery'
const MAX_WAIT_MS = 60_000
const FIRST_WAIT_MS = 5_000

export class DeliveryGaveUp extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number | null, lastError?: Error | null }} [info]
   */
  constructor(message, { status = null, lastError = null } = {}) {
    super(message)
    this.name = 'DeliveryGaveUp'
    this.status = status
    this.lastError = lastError
  }
}

/**
 * @param {{ baseUrl?: string, token?: string, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, budgetMs?: number, now?: () => number }} [opts]
 */
export function createDeliveryClient({
  baseUrl = process.env.ECOM_URL,
  token = process.env.DESIGN_WORKER_TOKEN,
  fetchImpl = fetch,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  budgetMs = 30 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (!baseUrl) throw new Error('ECOM_URL chưa được đặt')
  if (!token) throw new Error('DESIGN_WORKER_TOKEN chưa được đặt')
  const root = baseUrl.replace(/\/+$/, '')

  /**
   * @param {string} method
   * @param {string} route
   * @param {{ json?: unknown, body?: Buffer, contentType?: string }} [payload]
   * @returns {Promise<{ ok: boolean, status: number, body: any }>}
   */
  async function call(method, route, payload = {}) {
    const started = now()
    const headers = { Authorization: `Bearer ${token}` }
    let body
    if (payload.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(payload.json) }
    else if (payload.body) { headers['Content-Type'] = payload.contentType ?? 'application/octet-stream'; body = payload.body }
    for (let attempt = 0; ; attempt++) {
      let status = null
      let retryAfterMs = null
      let lastError = null
      try {
        const res = await fetchImpl(`${root}${route}`, { method, headers, body })
        status = res.status
        if (status !== 429 && status !== 503) {
          const text = await res.text()
          let parsed = null
          try { parsed = text ? JSON.parse(text) : null } catch { parsed = { error: text.slice(0, 300) } }
          return { ok: res.ok, status, body: parsed }
        }
        await res.body?.cancel?.().catch(() => {})
        const ra = Number(res.headers.get('retry-after'))
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra * 1000
      } catch (e) {
        lastError = e instanceof Error ? new Error(e.message) : new Error(String(e))
      }
      const wait = retryAfterMs ?? Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** attempt)
      if (now() - started + wait > budgetMs) {
        throw new DeliveryGaveUp(`${method} ${route}: không kết nối được sau ${attempt + 1} lần thử (${status ?? lastError?.message ?? 'lỗi mạng'})`, { status, lastError })
      }
      await sleep(wait)
    }
  }

  return {
    driveToken: () => call('POST', `${BASE}/drive-token`),
    taskState: key => call('GET', `${BASE}/tasks/${encodeURIComponent(key)}`),
    commit: (key, body) => call('POST', `${BASE}/tasks/${encodeURIComponent(key)}/commit`, { json: body }),
    putPreview: (artworkId, jpegBuffer) => call('PUT', `${BASE}/artworks/${encodeURIComponent(artworkId)}/preview`, { body: jpegBuffer, contentType: 'image/jpeg' }),
  }
}
