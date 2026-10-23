import { describe, it, expect } from 'vitest'
import { llmClientOptions, pickLlmKey } from '@/lib/llm/anthropic'

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
