import { z } from 'zod'
import { AnalysisSchema, type Analysis } from '@/lib/cs/analysis-schema'
import { LlmError, type Llm, type StructuredInput } from '@/lib/llm/types'

const KIE_RESPONSES_URL = 'https://api.kie.ai/openai/v1/responses'

type Parsed = { text: string; usage: { input: number; output: number } }

function fromResponseObject(r: any): Parsed {
  if (r?.status === 'failed' || r?.status === 'incomplete' || r?.error) {
    throw new LlmError(`kie responses ${r?.status ?? 'error'}: ${r?.error?.message ?? r?.incomplete_details?.reason ?? 'unknown error'}`)
  }
  const texts: string[] = []
  for (const item of r?.output ?? []) {
    if (item?.type !== 'message') continue
    for (const c of item.content ?? []) if (c?.type === 'output_text' && typeof c.text === 'string') texts.push(c.text)
  }
  if (!texts.length) throw new LlmError(`kie responses returned no output text (status ${r?.status ?? 'unknown'})`)
  return { text: texts.join(''), usage: { input: Number(r?.usage?.input_tokens ?? 0), output: Number(r?.usage?.output_tokens ?? 0) } }
}

export function parseResponsesBody(body: string): Parsed {
  const trimmed = body.trim()
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    let completed: any = null
    let failed: any = null
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      let ev: any
      try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (ev?.type === 'response.completed') completed = ev.response
      if (ev?.type === 'response.failed' || ev?.type === 'error') failed = ev.response ?? { status: 'failed', error: ev.error ?? ev }
    }
    if (failed) return fromResponseObject(failed)
    if (!completed) throw new LlmError('kie responses stream ended without response.completed')
    return fromResponseObject(completed)
  }
  let json: any
  try { json = JSON.parse(trimmed) } catch { throw new LlmError(`kie responses returned non-JSON: ${trimmed.slice(0, 200)}`) }
  if (json && typeof json === 'object' && 'code' in json && 'msg' in json && !('output' in json)) throw new LlmError(`kie error ${json.code}: ${json.msg}`)
  if (json?.error && !json.output) throw new LlmError(`kie responses error: ${json.error.message ?? JSON.stringify(json.error).slice(0, 200)}`)
  if (json?.type === 'response.failed' || json?.type === 'response.completed') return fromResponseObject(json.response)
  return fromResponseObject(json)
}

export function analysisJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AnalysisSchema) as Record<string, unknown>
}

export function kieResponsesLlm(apiKey: string, extra: { fetch?: typeof fetch } = {}): Llm {
  const fetchImpl = extra.fetch ?? fetch
  const llm: Llm = {
    async complete<T>({ system, user, model, schema, schemaName }: StructuredInput<T>) {
      const res = await fetchImpl(KIE_RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          instructions: system,
          input: user,
          reasoning: { effort: 'low' },
          text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: z.toJSONSchema(schema as any) } },
        }),
      })
      const body = await res.text()
      if (!res.ok && !body.trim().startsWith('{') && !body.trim().startsWith('event:')) throw new LlmError(`kie responses HTTP ${res.status}: ${body.slice(0, 200)}`)
      const { text, usage } = parseResponsesBody(body)
      let parsed: T
      try { parsed = schema.parse(JSON.parse(text)) } catch (err: any) { throw new LlmError(`kie responses returned an unparsable ${schemaName}: ${err?.message ?? err}`) }
      return { output: parsed, tokensIn: usage.input, tokensOut: usage.output }
    },
    analyze: input => llm.complete<Analysis>({ ...input, schema: AnalysisSchema, schemaName: 'cs_analysis' }),
  }
  return llm
}

export async function pingKieResponses(apiKey: string, model: string, extra: { fetch?: typeof fetch } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await (extra.fetch ?? fetch)(KIE_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, input: 'ping', reasoning: { effort: 'low' } }),
    })
    parseResponsesBody(await res.text())
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}
