import { describe, it, expect } from 'vitest'
import { LlmError, llmClientOptions, llmFor, normalizeModelId, pickLlmKey } from '@/lib/llm/anthropic'

describe('llmClientOptions', () => {
  it('kie talks to api.kie.ai/claude with a bearer token', () => {
    expect(llmClientOptions('kie', 'kie-key')).toEqual({ baseURL: 'https://api.kie.ai/claude', authToken: 'kie-key', maxRetries: 2 })
  })
  it('anthropic uses the official endpoint with an api key', () => {
    expect(llmClientOptions('anthropic', 'sk-ant')).toEqual({ apiKey: 'sk-ant', maxRetries: 2 })
  })
})

describe('pickLlmKey', () => {
  const secrets = { freshdeskApiKey: null, anthropicApiKey: 'sk-ant', kieApiKey: 'kie-key' }
  it('returns the key of the selected provider only', () => {
    expect(pickLlmKey('kie', secrets)).toBe('kie-key')
    expect(pickLlmKey('anthropic', secrets)).toBe('sk-ant')
    expect(pickLlmKey('kie', { ...secrets, kieApiKey: null })).toBeNull()
  })
})

describe('normalizeModelId', () => {
  it('turns a Kie display name into its slug', () => {
    expect(normalizeModelId('GPT 6.1 Sol')).toBe('gpt-6.1-sol')
    expect(normalizeModelId('  Claude Opus 5.5 ')).toBe('claude-opus-5.5')
    expect(normalizeModelId('claude-opus-5-5')).toBe('claude-opus-5-5')
  })
})

describe('llmFor', () => {
  const capture = () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ code: 500, msg: 'stop' }), { status: 200 }) }) as unknown as typeof fetch
    return { urls, fetchImpl }
  }
  it('routes claude models on kie to /claude/v1/messages', async () => {
    const c = capture()
    await llmFor('kie', 'claude-opus-5-5', 'k', { fetch: c.fetchImpl }).analyze({ system: 's', user: 'u', model: 'claude-opus-5-5' }).catch(() => {})
    expect(c.urls[0]).toBe('https://api.kie.ai/claude/v1/messages')
  })
  it('routes other models on kie to /openai/v1/responses', async () => {
    const c = capture()
    await llmFor('kie', 'gpt-6.1-sol', 'k', { fetch: c.fetchImpl }).analyze({ system: 's', user: 'u', model: 'gpt-6.1-sol' }).catch(() => {})
    expect(c.urls[0]).toBe('https://api.kie.ai/openai/v1/responses')
  })
  it('refuses a non-claude model on anthropic', () => {
    expect(() => llmFor('anthropic', 'gpt-6.1-sol', 'k')).toThrow(LlmError)
  })
})
