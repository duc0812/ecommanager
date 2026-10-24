import { describe, expect, it } from 'vitest'
import { REPLICATE_MODELS, replicateClient } from '@/lib/creative/replicate'

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

describe('REPLICATE_MODELS', () => {
  it('lists the curated China models with provider replicate', () => {
    expect(REPLICATE_MODELS.map(m => m.slug)).toEqual([
      'qwen/qwen-image', 'qwen/qwen-image-edit', 'qwen/qwen-image-edit-plus', 'bytedance/seedream-4', 'bytedance/seedream-4.5',
      'tencent/hunyuan-image-3', 'prunaai/wan-2.2-image', 'minimax/image-01',
    ])
    expect(REPLICATE_MODELS.every(m => m.provider === 'replicate' && m.china)).toBe(true)
  })
})

describe('replicateClient', () => {
  const modelDoc = {
    owner: 'qwen', name: 'qwen-image',
    latest_version: { id: 'v1', openapi_schema: { components: { schemas: { Input: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, image: { type: 'string', format: 'uri' } } }, Output: { type: 'array', items: { type: 'string', format: 'uri' } } } } } },
  }

  it('reads the Input schema with the document as root', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: modelDoc }))
    const s = await replicateClient('r8_x', fn).schema('qwen/qwen-image')
    expect(calls[0].url).toBe('https://api.replicate.com/v1/models/qwen/qwen-image')
    expect((calls[0].init?.headers as any).Authorization).toBe('Bearer r8_x')
    expect(s?.input).toEqual(modelDoc.latest_version.openapi_schema.components.schemas.Input)
    expect(s?.root).toEqual(modelDoc.latest_version.openapi_schema)
  })

  it('returns null when the model has no version schema', async () => {
    const { fn } = fakeFetch(() => ({ body: { owner: 'a', name: 'b', latest_version: null } }))
    expect(await replicateClient('r', fn).schema('a/b')).toBeNull()
  })

  it('uploads a file as multipart content and returns its get url', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 201, body: { id: 'f1', urls: { get: 'https://api.replicate.com/v1/files/f1' } } }))
    const url = await replicateClient('r', fn).uploadFile(Buffer.from('png-bytes'), 'ref-0.png', 'image/png')
    expect(url).toBe('https://api.replicate.com/v1/files/f1')
    expect(calls[0].url).toBe('https://api.replicate.com/v1/files')
    const form = calls[0].init?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const file = form.get('content') as File
    expect(file.name).toBe('ref-0.png')
    expect(file.type).toBe('image/png')
  })

  it('creates a prediction on the model endpoint and returns its id', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 201, body: { id: 'p-1', status: 'starting' } }))
    const id = await replicateClient('r', fn).createPrediction('qwen/qwen-image', { prompt: 'hi' })
    expect(id).toBe('p-1')
    expect(calls[0].url).toBe('https://api.replicate.com/v1/models/qwen/qwen-image/predictions')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ input: { prompt: 'hi' } })
  })

  it('throws on a non-2xx response with the status and detail', async () => {
    const { fn } = fakeFetch(() => ({ status: 422, body: { detail: 'prompt is required' } }))
    await expect(replicateClient('r', fn).createPrediction('a/b', {})).rejects.toThrow('replicate HTTP 422: prompt is required')
  })

  it('maps prediction states, string and array outputs', async () => {
    const states: any[] = [
      { status: 'starting' },
      { status: 'processing' },
      { status: 'succeeded', output: ['https://r/1.png', 'https://r/2.png'], metrics: { predict_time: 4.2 } },
      { status: 'succeeded', output: 'https://r/3.png' },
      { status: 'failed', error: 'NSFW content detected' },
      { status: 'canceled' },
    ]
    let i = 0
    const { fn, calls } = fakeFetch(() => ({ body: { id: 'p', ...states[i++] } }))
    const client = replicateClient('r', fn)
    expect(await client.poll('p')).toEqual({ state: 'running' })
    expect(await client.poll('p')).toEqual({ state: 'running' })
    expect(await client.poll('p')).toEqual({ state: 'done', urls: ['https://r/1.png', 'https://r/2.png'], credits: null, costTime: 4.2 })
    expect(await client.poll('p')).toEqual({ state: 'done', urls: ['https://r/3.png'], credits: null, costTime: null })
    expect(await client.poll('p')).toEqual({ state: 'failed', error: 'NSFW content detected' })
    expect(await client.poll('p')).toEqual({ state: 'failed', error: 'canceled' })
    expect(calls[0].url).toBe('https://api.replicate.com/v1/predictions/p')
  })
})
