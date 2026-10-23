import { describe, it, expect } from 'vitest'
import { kieResponsesLlm, parseResponsesBody } from '@/lib/llm/kie-responses'
import { LlmError } from '@/lib/llm/anthropic'

const analysis = { category: 'ORDER_STATUS', urgency: 'NORMAL', sentiment: 'CALM', orderNumber: '#LIT1', summary: 's', facts: [], proposal: 'p', citedCaseIds: [], draftReply: null, needsHuman: true, needsHumanReason: 'r', autoReplyEligible: false, autoReplyReason: 'a' }
const responseObject = {
  id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-6.1-sol',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] },
  ],
  usage: { input_tokens: 65, output_tokens: 31, total_tokens: 96 },
}
const sse = [
  'event: response.created', 'data: {"type":"response.created","response":{"status":"in_progress","output":[]}}', '',
  'event: response.output_text.delta', 'data: {"type":"response.output_text.delta","delta":"{\\"cat"}', '',
  'event: response.completed', `data: ${JSON.stringify({ type: 'response.completed', response: responseObject })}`, '',
].join('\n')

describe('parseResponsesBody', () => {
  it('reads the output text and usage from a JSON response object', () => {
    const r = parseResponsesBody(JSON.stringify(responseObject))
    expect(r.text).toBe(JSON.stringify(analysis))
    expect(r.usage).toEqual({ input: 65, output: 31 })
  })
  it('reads the response.completed event from an SSE stream', () => {
    const r = parseResponsesBody(sse)
    expect(r.text).toBe(JSON.stringify(analysis))
    expect(r.usage).toEqual({ input: 65, output: 31 })
  })
  it('turns a Kie envelope into an LlmError', () => {
    expect(() => parseResponsesBody(JSON.stringify({ code: 401, msg: 'The API key is not authorized to use this model.', data: null }))).toThrow(LlmError)
    expect(() => parseResponsesBody(JSON.stringify({ error: { message: 'bad model', type: 'invalid_request_error' } }))).toThrow(/bad model/)
  })
  it('reports a failed response', () => {
    const failed = { ...responseObject, status: 'failed', output: [], error: { message: 'model overloaded' } }
    expect(() => parseResponsesBody(JSON.stringify({ type: 'response.failed', response: failed }))).toThrow(/overloaded/)
  })
})

describe('kieResponsesLlm', () => {
  it('posts a strict json_schema request and returns the parsed analysis', async () => {
    let seen: { url: string; body: any } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) }
      return new Response(JSON.stringify(responseObject), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const llm = kieResponsesLlm('kie-key', { fetch: fetchImpl })
    const res = await llm.analyze({ system: 'SYSTEM', user: 'USER', model: 'gpt-6.1-sol' })
    expect(res.output.category).toBe('ORDER_STATUS')
    expect(res.tokensIn).toBe(65)
    expect(res.tokensOut).toBe(31)
    expect(seen!.url).toBe('https://api.kie.ai/openai/v1/responses')
    expect(seen!.body.model).toBe('gpt-6.1-sol')
    expect(seen!.body.stream).toBe(false)
    expect(seen!.body.instructions).toBe('SYSTEM')
    expect(seen!.body.input).toBe('USER')
    expect(seen!.body.reasoning).toEqual({ effort: 'low' })
    expect(seen!.body.text.format.type).toBe('json_schema')
    expect(seen!.body.text.format.strict).toBe(true)
    expect(seen!.body.text.format.schema.additionalProperties).toBe(false)
    expect(seen!.body.text.format.schema.required).toContain('draftReply')
  })
  it('rejects an analysis that does not match the schema', async () => {
    const bad = { ...responseObject, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"category":"NOPE"}' }] }] }
    const fetchImpl = (async () => new Response(JSON.stringify(bad), { status: 200 })) as unknown as typeof fetch
    const llm = kieResponsesLlm('k', { fetch: fetchImpl })
    await expect(llm.analyze({ system: 's', user: 'u', model: 'gpt-6.1-sol' })).rejects.toBeInstanceOf(LlmError)
  })
})
