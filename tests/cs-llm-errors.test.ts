import { describe, it, expect } from 'vitest'
import { claudeLlm, LlmError } from '@/lib/llm/anthropic'

function fakeFetch(body: unknown, status = 200) {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('claudeLlm error shapes', () => {
  it('turns a Kie envelope error into an LlmError with the provider message', async () => {
    const llm = claudeLlm('kie', 'k', { fetch: fakeFetch({ code: 401, msg: 'The API key is not authorized to use this model.', data: null }) })
    const err = await llm.analyze({ system: 's', user: 'u', model: 'claude-haiku-5-5' }).catch(e => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.message).toContain('not authorized')
    expect(err.message).toContain('kie')
  })

  it('parses a normal structured-output message', async () => {
    const analysis = { category: 'ORDER_STATUS', urgency: 'NORMAL', sentiment: 'CALM', orderNumber: '#LIT1', summary: 's', facts: [], proposal: 'p', citedCaseIds: [], draftReply: null, needsHuman: true, needsHumanReason: 'r', autoReplyEligible: false, autoReplyReason: 'a' }
    const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: JSON.stringify(analysis) }], usage: { input_tokens: 11, output_tokens: 7 } }
    const llm = claudeLlm('anthropic', 'k', { fetch: fakeFetch(message) })
    const res = await llm.analyze({ system: 's', user: 'u', model: 'claude-haiku-5-5' })
    expect(res.output.category).toBe('ORDER_STATUS')
    expect(res.tokensIn).toBe(11)
  })
})
