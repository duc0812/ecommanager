import type { z } from 'zod'
import type { Analysis } from '@/lib/cs/analysis-schema'

export type StructuredInput<T> = { system: string; user: string; model: string; schema: z.ZodType<T>; schemaName: string }
export type LlmResult<T> = { output: T; tokensIn: number; tokensOut: number }

export type Llm = {
  complete<T>(input: StructuredInput<T>): Promise<LlmResult<T>>
  analyze(input: { system: string; user: string; model: string }): Promise<LlmResult<Analysis>>
}

export type LlmProvider = 'anthropic' | 'kie'
export const LLM_PROVIDERS: LlmProvider[] = ['anthropic', 'kie']

export class LlmError extends Error {}
