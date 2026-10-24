export type CatalogModel = {
  provider: 'kie' | 'replicate'
  slug: string
  title: string
  vendor: string
  taskTypes: string[]
  pricing: string | null
  china: boolean
}

export type PollResult =
  | { state: 'running' }
  | { state: 'done'; urls: string[]; credits: number | null; costTime: number | null }
  | { state: 'failed'; error: string }

const KIE_API = 'https://api.kie.ai'
const KIE_UPLOAD = 'https://kieai.redpandaai.co/api/file-base64-upload'
const IMAGE_TASK_TYPES = ['Text to Image', 'Image to Image', 'Image Editing']
const CHINA_MARKERS = ['qwen', 'bytedance', 'seedream', 'wan', 'hunyuan', 'tencent', 'kling', 'minimax', 'hailuo', 'vidu', 'zhipu', 'z-image', 'glm']
const CATALOG_TTL_MS = 10 * 60 * 1000

export function isChinaModel(vendor: string, slug: string): boolean {
  const hay = `${vendor} ${slug}`.toLowerCase()
  return CHINA_MARKERS.some(m => hay.includes(m))
}

export function filterImageModels(models: any[]): CatalogModel[] {
  const out: CatalogModel[] = []
  for (const m of models ?? []) {
    const taskTypes: string[] = Array.isArray(m?.taskType) ? m.taskType : []
    if (!taskTypes.some(t => IMAGE_TASK_TYPES.includes(t))) continue
    const slug = String(m.model ?? m.slug ?? '')
    if (!slug) continue
    const vendor = String(m.provider ?? '')
    out.push({ provider: 'kie', slug, title: String(m.title ?? slug), vendor, taskTypes, pricing: m.pricingDesc ? String(m.pricingDesc) : null, china: isChinaModel(vendor, slug) })
  }
  return out.sort((a, b) => Number(b.china) - Number(a.china) || a.vendor.localeCompare(b.vendor) || a.slug.localeCompare(b.slug))
}

export function parseKieEnvelope(body: string, what: string): any {
  let json: any
  try { json = JSON.parse(body) } catch { throw new Error(`kie ${what} returned non-JSON: ${body.slice(0, 200)}`) }
  if (Number(json?.code) !== 200) throw new Error(`kie ${what} ${json?.code ?? '?'}: ${json?.msg ?? 'unknown error'}`)
  return json.data
}

const catalogCache = new Map<string, { at: number; models: CatalogModel[] }>()

export function kieClient(apiKey: string, fetchImpl: typeof fetch = fetch) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }

  async function call(url: string, what: string, init?: RequestInit) {
    const res = await fetchImpl(url, { ...init, headers: { ...headers, ...(init?.headers as any) } })
    const body = await res.text()
    if (!res.ok && !body.trim().startsWith('{')) throw new Error(`kie ${what} HTTP ${res.status}: ${body.slice(0, 200)}`)
    return parseKieEnvelope(body, what)
  }

  return {
    async catalog(force = false): Promise<CatalogModel[]> {
      const cached = catalogCache.get(apiKey)
      if (!force && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models
      const data = await call(`${KIE_API}/api/v1/models`, 'catalog')
      const models = filterImageModels(data?.models ?? [])
      catalogCache.set(apiKey, { at: Date.now(), models })
      return models
    },

    async schema(slug: string): Promise<{ input: any; root: any } | null> {
      const data = await call(`${KIE_API}/api/v1/models/${slug}/schema`, 'schema')
      const root = data?.openapi
      if (!root) return null
      const post = root.paths?.['/api/v1/jobs/createTask']?.post
      const bodySchema = post?.requestBody?.content?.['application/json']?.schema
      const resolved = bodySchema?.$ref ? resolveLocal(bodySchema.$ref, root) : bodySchema
      const input = resolved?.properties?.input
      if (!input) return null
      return { input, root }
    },

    async uploadBase64(dataUrl: string, fileName: string): Promise<string> {
      const res = await fetchImpl(KIE_UPLOAD, { method: 'POST', headers, body: JSON.stringify({ base64Data: dataUrl, uploadPath: 'images/creative', fileName }) })
      const body = await res.text()
      let json: any
      try { json = JSON.parse(body) } catch { throw new Error(`kie upload returned non-JSON: ${body.slice(0, 200)}`) }
      const url = json?.data?.downloadUrl
      if (!url || Number(json?.code) !== 200) throw new Error(`kie upload ${json?.code ?? res.status}: ${json?.msg ?? 'no downloadUrl'}`)
      return String(url)
    },

    async createTask(model: string, input: Record<string, unknown>): Promise<string> {
      const data = await call(`${KIE_API}/api/v1/jobs/createTask`, 'createTask', { method: 'POST', body: JSON.stringify({ model, input }) })
      if (!data?.taskId) throw new Error('kie createTask returned no taskId')
      return String(data.taskId)
    },

    async poll(taskId: string): Promise<PollResult> {
      const data = await call(`${KIE_API}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, 'recordInfo')
      const state = String(data?.state ?? '')
      if (state === 'fail') return { state: 'failed', error: String(data?.failMsg ?? data?.failCode ?? 'unknown error') }
      if (state !== 'success') return { state: 'running' }
      let response = data?.response
      if (!response && typeof data?.resultJson === 'string') { try { response = JSON.parse(data.resultJson) } catch { response = null } }
      const urls: string[] = Array.isArray(response?.resultUrls) ? response.resultUrls.map(String) : []
      if (!urls.length) return { state: 'failed', error: 'kie task succeeded without result urls' }
      return { state: 'done', urls, credits: data?.creditsConsumed == null ? null : Number(data.creditsConsumed), costTime: data?.costTime == null ? null : Number(data.costTime) }
    },
  }
}

function resolveLocal(ref: string, root: any): any {
  let cur = root
  for (const seg of ref.replace(/^#\//, '').split('/')) {
    cur = cur?.[decodeURIComponent(seg)]
    if (cur == null) return null
  }
  return cur
}
