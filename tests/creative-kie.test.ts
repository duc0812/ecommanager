import { describe, expect, it } from 'vitest'
import { filterImageModels, isChinaModel, kieClient, parseKieEnvelope } from '@/lib/creative/kie'

type Call = { url: string; init?: RequestInit }

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  const fn = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const r = handler(String(url), init)
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return new Response(body, { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const catalog = [
  { model: 'qwen/text-to-image', title: 'Qwen', provider: 'Qwen', taskType: ['Text to Image'], pricingDesc: '4 credits' },
  { model: 'google/imagen4', title: 'Imagen', provider: 'Google', taskType: ['Text to Image'], pricingDesc: null },
  { model: 'kling/v2-1', title: 'Kling video', provider: 'Kling', taskType: ['Image to Video'], pricingDesc: '' },
  { model: 'seedream/4.5-edit', title: 'Seedream edit', provider: 'ByteDance', taskType: ['Image to Image'], pricingDesc: '6.5' },
  { model: 'flux-3/klein-edit-image', title: 'Flux', provider: 'Black Forest Labs', taskType: ['Image Editing'], pricingDesc: '1.6' },
]

describe('isChinaModel', () => {
  it('matches Chinese vendors by provider or slug', () => {
    expect(isChinaModel('Qwen', 'qwen/text-to-image')).toBe(true)
    expect(isChinaModel('Other', 'seedream/4.5')).toBe(true)
    expect(isChinaModel('Google', 'google/imagen4')).toBe(false)
  })
})

describe('filterImageModels', () => {
  it('keeps image task types only and lists China models first', () => {
    const models = filterImageModels(catalog)
    expect(models.map(m => m.slug)).toEqual(['seedream/4.5-edit', 'qwen/text-to-image', 'flux-3/klein-edit-image', 'google/imagen4'])
    expect(models[1]).toEqual({ provider: 'kie', slug: 'qwen/text-to-image', title: 'Qwen', vendor: 'Qwen', taskTypes: ['Text to Image'], pricing: '4 credits', china: true })
    expect(models[3].china).toBe(false)
    expect(models[3].pricing).toBeNull()
  })
})

describe('parseKieEnvelope', () => {
  it('returns data when code is 200 and throws the msg otherwise', () => {
    expect(parseKieEnvelope(JSON.stringify({ code: 200, msg: 'success', data: { a: 1 } }), 'catalog')).toEqual({ a: 1 })
    expect(() => parseKieEnvelope(JSON.stringify({ code: 402, msg: 'Insufficient credits', data: null }), 'createTask')).toThrow('kie createTask 402: Insufficient credits')
    expect(() => parseKieEnvelope('<html>', 'catalog')).toThrow(/non-JSON/)
  })
})

describe('kieClient', () => {
  const schemaDoc = {
    openapi: '3.1.0',
    paths: { '/api/v1/jobs/createTask': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Req' } } } } } } },
    components: { schemas: { Req: { type: 'object', properties: { model: { type: 'string' }, input: { $ref: '#/components/schemas/Input' } } }, Input: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, image_urls: { type: 'array', items: { type: 'string' } } } } } },
  }

  it('reads the catalog once and again on force', async () => {
    let hits = 0
    const { fn } = fakeFetch(() => { hits++; return { body: { code: 200, msg: 'success', data: { total: catalog.length, models: catalog } } } })
    const client = kieClient('k-test-1', fn)
    await client.catalog()
    const models = await client.catalog()
    expect(hits).toBe(1)
    expect(models).toHaveLength(4)
    await client.catalog(true)
    expect(hits).toBe(2)
  })

  it('returns the input schema and the document root for a model', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { code: 200, msg: 'success', data: { model: 'qwen/text-to-image', openapi: schemaDoc } } }))
    const s = await kieClient('k', fn).schema('qwen/text-to-image')
    expect(calls[0].url).toBe('https://api.kie.ai/api/v1/models/qwen/text-to-image/schema')
    expect(s?.input).toEqual({ $ref: '#/components/schemas/Input' })
    expect(s?.root).toEqual(schemaDoc)
  })

  it('returns null when the model has no openapi document', async () => {
    const { fn } = fakeFetch(() => ({ body: { code: 200, msg: 'success', data: { model: 'x', openapi: null } } }))
    expect(await kieClient('k', fn).schema('x')).toBeNull()
  })

  it('uploads a data url and returns the download url', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { success: true, code: 200, msg: 'ok', data: { downloadUrl: 'https://tempfile.redpandaai.co/a.png' } } }))
    const url = await kieClient('k', fn).uploadBase64('data:image/png;base64,AAAA', 'ref-0.png')
    expect(url).toBe('https://tempfile.redpandaai.co/a.png')
    expect(calls[0].url).toBe('https://kieai.redpandaai.co/api/file-base64-upload')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ base64Data: 'data:image/png;base64,AAAA', uploadPath: 'images/creative', fileName: 'ref-0.png' })
  })

  it('creates a task with the bearer header and returns the taskId', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { code: 200, msg: 'success', data: { taskId: 't-1', recordId: 'r-1' } } }))
    const id = await kieClient('k-secret', fn).createTask('qwen/text-to-image', { prompt: 'hi' })
    expect(id).toBe('t-1')
    expect(calls[0].url).toBe('https://api.kie.ai/api/v1/jobs/createTask')
    expect((calls[0].init?.headers as any).Authorization).toBe('Bearer k-secret')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ model: 'qwen/text-to-image', input: { prompt: 'hi' } })
  })

  it('surfaces a rejected createTask even on HTTP 200', async () => {
    const { fn } = fakeFetch(() => ({ body: { code: 429, msg: 'Too many requests', data: null } }))
    await expect(kieClient('k', fn).createTask('m', {})).rejects.toThrow('kie createTask 429: Too many requests')
  })

  it('maps poll states', async () => {
    const states: any[] = [
      { state: 'queuing', successFlag: 0 },
      { state: 'generating', successFlag: 0 },
      { state: 'success', successFlag: 1, creditsConsumed: 6.5, costTime: 41, response: { resultUrls: ['https://f/1.png', 'https://f/2.png'] } },
      { state: 'success', successFlag: 1, resultJson: '{"resultUrls":["https://f/3.png"]}' },
      { state: 'fail', successFlag: 3, failCode: '500', failMsg: 'content blocked' },
    ]
    let i = 0
    const { fn, calls } = fakeFetch(() => ({ body: { code: 200, msg: 'success', data: { taskId: 't', ...states[i++] } } }))
    const client = kieClient('k', fn)
    expect(await client.poll('t')).toEqual({ state: 'running' })
    expect(await client.poll('t')).toEqual({ state: 'running' })
    expect(await client.poll('t')).toEqual({ state: 'done', urls: ['https://f/1.png', 'https://f/2.png'], credits: 6.5, costTime: 41 })
    expect(await client.poll('t')).toEqual({ state: 'done', urls: ['https://f/3.png'], credits: null, costTime: null })
    expect(await client.poll('t')).toEqual({ state: 'failed', error: 'content blocked' })
    expect(calls[0].url).toBe('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=t')
  })
})
