import type { CatalogModel, PollResult } from '@/lib/creative/kie'

const REPLICATE_API = 'https://api.replicate.com/v1'

const CURATED: Array<[slug: string, title: string, vendor: string, taskTypes: string[]]> = [
  ['qwen/qwen-image', 'Qwen Image', 'Qwen', ['Text to Image']],
  ['qwen/qwen-image-edit', 'Qwen Image Edit', 'Qwen', ['Image to Image']],
  ['qwen/qwen-image-edit-plus', 'Qwen Image Edit Plus', 'Qwen', ['Image to Image']],
  ['bytedance/seedream-4', 'Seedream 4', 'ByteDance', ['Text to Image', 'Image to Image']],
  ['bytedance/seedream-4.5', 'Seedream 4.5', 'ByteDance', ['Text to Image', 'Image to Image']],
  ['tencent/hunyuan-image-3', 'Hunyuan Image 3', 'Tencent', ['Text to Image']],
  ['prunaai/wan-2.2-image', 'Wan 2.2 Image', 'Wan', ['Text to Image']],
  ['minimax/image-01', 'MiniMax Image 01', 'MiniMax', ['Text to Image']],
]

export const REPLICATE_MODELS: CatalogModel[] = CURATED.map(([slug, title, vendor, taskTypes]) => ({ provider: 'replicate', slug, title, vendor, taskTypes, pricing: null, china: true }))

export function replicateClient(token: string, fetchImpl: typeof fetch = fetch) {
  const auth = { Authorization: `Bearer ${token}` }

  async function call(path: string, init?: RequestInit): Promise<any> {
    const res = await fetchImpl(`${REPLICATE_API}${path}`, { ...init, headers: { ...auth, ...(init?.headers as any) } })
    const body = await res.text()
    let json: any = null
    try { json = JSON.parse(body) } catch { json = null }
    if (!res.ok) throw new Error(`replicate HTTP ${res.status}: ${json?.detail ?? json?.error ?? body.slice(0, 200)}`)
    if (json === null) throw new Error(`replicate returned non-JSON: ${body.slice(0, 200)}`)
    return json
  }

  return {
    async schema(slug: string): Promise<{ input: any; root: any } | null> {
      const doc = await call(`/models/${slug}`)
      const root = doc?.latest_version?.openapi_schema
      const input = root?.components?.schemas?.Input
      if (!input) return null
      return { input, root }
    },

    async uploadFile(bytes: Buffer, fileName: string, mime: string): Promise<string> {
      const form = new FormData()
      form.append('content', new File([new Uint8Array(bytes)], fileName, { type: mime }), fileName)
      const json = await call('/files', { method: 'POST', body: form })
      const url = json?.urls?.get
      if (!url) throw new Error('replicate upload returned no url')
      return String(url)
    },

    async createPrediction(slug: string, input: Record<string, unknown>): Promise<string> {
      const doc = await call(`/models/${slug}`)
      const version = doc?.latest_version?.id
      if (!version) throw new Error(`replicate model ${slug} has no runnable version`)
      const json = await call('/predictions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: String(version), input }) })
      if (!json?.id) throw new Error('replicate prediction returned no id')
      return String(json.id)
    },

    async poll(id: string): Promise<PollResult> {
      const json = await call(`/predictions/${encodeURIComponent(id)}`)
      const status = String(json?.status ?? '')
      if (status === 'succeeded') {
        const out = json.output
        const urls: string[] = Array.isArray(out) ? out.map(String) : typeof out === 'string' ? [out] : []
        if (!urls.length) return { state: 'failed', error: 'replicate prediction succeeded without output' }
        const t = json?.metrics?.predict_time
        return { state: 'done', urls, credits: null, costTime: t == null ? null : Number(t) }
      }
      if (status === 'failed') return { state: 'failed', error: String(json?.error ?? 'unknown error') }
      if (status === 'canceled') return { state: 'failed', error: 'canceled' }
      return { state: 'running' }
    },
  }
}
