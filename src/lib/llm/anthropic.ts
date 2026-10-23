import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { AnalysisSchema, type Analysis } from '@/lib/cs/analysis-schema'

export type Llm = {
  analyze(input: { system: string; user: string; model: string }): Promise<{ output: Analysis; tokensIn: number; tokensOut: number }>
}

export type LlmProvider = 'anthropic' | 'kie'
export const LLM_PROVIDERS: LlmProvider[] = ['anthropic', 'kie']

export class LlmError extends Error {}

const KIE_CLAUDE_BASE_URL = 'https://api.kie.ai/claude'

export function llmClientOptions(provider: LlmProvider, key: string): ConstructorParameters<typeof Anthropic>[0] {
  if (provider === 'kie') return { baseURL: KIE_CLAUDE_BASE_URL, authToken: key, maxRetries: 2 }
  return { apiKey: key, maxRetries: 2 }
}

export function pickLlmKey(provider: LlmProvider, secrets: { anthropicApiKey: string | null; kieApiKey: string | null }): string | null {
  return provider === 'kie' ? secrets.kieApiKey : secrets.anthropicApiKey
}

export function claudeLlm(provider: LlmProvider, key: string): Llm {
  const client = new Anthropic(llmClientOptions(provider, key))
  return {
    async analyze({ system, user, model }) {
      const res = await client.messages.parse({
        model,
        max_tokens: 4000,
        output_config: { effort: 'low', format: zodOutputFormat(AnalysisSchema) },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      })
      if (res.stop_reason === 'refusal') throw new LlmError(`Claude refused: ${res.stop_details?.explanation ?? 'no explanation'}`)
      if (!res.parsed_output) throw new LlmError(`Claude returned no parsable analysis (stop_reason ${res.stop_reason})`)
      return { output: res.parsed_output, tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens }
    },
  }
}

export function anthropicLlm(apiKey: string): Llm {
  return claudeLlm('anthropic', apiKey)
}

export async function pingLlm(provider: LlmProvider, key: string, model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = new Anthropic({ ...llmClientOptions(provider, key), maxRetries: 0 })
    await client.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

export const pingAnthropic = (apiKey: string, model: string) => pingLlm('anthropic', apiKey, model)
