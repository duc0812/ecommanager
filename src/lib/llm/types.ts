import type { Analysis } from '@/lib/cs/analysis-schema'

export type Llm = {
  analyze(input: { system: string; user: string; model: string }): Promise<{ output: Analysis; tokensIn: number; tokensOut: number }>
}

export type LlmProvider = 'anthropic' | 'kie'
export const LLM_PROVIDERS: LlmProvider[] = ['anthropic', 'kie']

export class LlmError extends Error {}
