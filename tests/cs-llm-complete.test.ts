import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { claudeLlm } from '@/lib/llm/anthropic'
import { kieResponsesLlm } from '@/lib/llm/kie-responses'

const message = (text: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 3 } })
const responses = (text: string) => ({ id: 'resp_1', object: 'response', status: 'completed', model: 'm', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 5, output_tokens: 3 } })
const Small = z.object({ a: z.number() })

describe('Llm.complete', () => {
  it('claudeLlm.complete parses any zod schema', async () => {
    const llm = claudeLlm('anthropic', 'k', { fetch: (async () => new Response(JSON.stringify(message('{"a":1}')), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch })
    const r = await llm.complete({ system: 's', user: 'u', model: 'claude-haiku-5-5', schema: Small, schemaName: 'small' })
    expect(r.output.a).toBe(1)
    expect(r.tokensIn).toBe(5)
  })
  it('kieResponsesLlm.complete sends the given schema name', async () => {
    let body: any = null
    const llm = kieResponsesLlm('k', { fetch: (async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify(responses('{"a":2}')), { status: 200, headers: { 'content-type': 'application/json' } }) }) as unknown as typeof fetch })
    const r = await llm.complete({ system: 's', user: 'u', model: 'gpt-6.1-sol', schema: Small, schemaName: 'root_cause' })
    expect(r.output.a).toBe(2)
    expect(body.text.format.name).toBe('root_cause')
    expect(body.text.format.schema.properties.a.type).toBe('number')
  })
  it('analyze still works through complete', async () => {
    const analysis = { category: 'ORDER_STATUS', urgency: 'NORMAL', sentiment: 'CALM', orderNumber: null, summary: 's', facts: [], proposal: 'p', citedCaseIds: [], draftReply: null, needsHuman: true, needsHumanReason: 'r', autoReplyEligible: false, autoReplyReason: 'a' }
    const llm = claudeLlm('anthropic', 'k', { fetch: (async () => new Response(JSON.stringify(message(JSON.stringify(analysis))), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch })
    const r = await llm.analyze({ system: 's', user: 'u', model: 'claude-haiku-5-5' })
    expect(r.output.category).toBe('ORDER_STATUS')
  })
})
