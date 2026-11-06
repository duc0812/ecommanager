import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { kieVision } from '@/lib/scale/vision'

const Schema = z.object({ garment: z.string() })
const okBody = (text: string) => JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1 } })

function fakeFetch(body: string, status = 200) {
  const calls: { url: string; init: any }[] = []
  const impl = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(body, { status }) }) as unknown as typeof fetch
  return { calls, impl }
}

describe('kie vision', () => {
  it('sends the text and every image in order with a strict json schema and returns the parsed object', async () => {
    const f = fakeFetch(okBody('{"garment":"varsity jacket"}'))
    const out = await kieVision('key-1', f.impl).describe({ model: 'gpt-6.1-sol', system: 'sys', text: 'describe', images: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'], schema: Schema, schemaName: 'scale_design' })
    expect(out).toEqual({ garment: 'varsity jacket' })
    expect(f.calls[0].url).toBe('https://api.kie.ai/openai/v1/responses')
    expect(f.calls[0].init.headers.Authorization).toBe('Bearer key-1')
    const body = JSON.parse(f.calls[0].init.body)
    expect(body.model).toBe('gpt-6.1-sol')
    expect(body.instructions).toBe('sys')
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: 'describe' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
      { type: 'input_image', image_url: 'data:image/png;base64,BBB' },
    ])
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'scale_design', strict: true })
  })

  it('surfaces a Kie authorisation envelope with its code and message', async () => {
    const f = fakeFetch(JSON.stringify({ code: 401, msg: 'The API key is not authorized to use this model.' }))
    await expect(kieVision('k', f.impl).describe({ model: 'm', system: 's', text: 't', images: [], schema: Schema, schemaName: 'x' })).rejects.toThrow(/401.*not authorized/)
  })

  it('rejects output that does not fit the schema', async () => {
    const f = fakeFetch(okBody('{"nope":1}'))
    await expect(kieVision('k', f.impl).describe({ model: 'm', system: 's', text: 't', images: [], schema: Schema, schemaName: 'scale_design' })).rejects.toThrow(/unparsable scale_design/)
  })

  it('reports a non-JSON gateway error with its status', async () => {
    const f = fakeFetch('<html>Bad gateway</html>', 502)
    await expect(kieVision('k', f.impl).describe({ model: 'm', system: 's', text: 't', images: [], schema: Schema, schemaName: 'x' })).rejects.toThrow(/kie vision HTTP 502/)
  })
})
