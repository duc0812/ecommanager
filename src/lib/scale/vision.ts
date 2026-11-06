import { z } from 'zod'
import { parseResponsesBody } from '@/lib/llm/kie-responses'

const KIE_RESPONSES_URL = 'https://api.kie.ai/openai/v1/responses'
const TIMEOUT_MS = 4 * 60 * 1000
const ATTEMPTS = 3

export type VisionInput<T> = { model: string; system: string; text: string; images: string[]; schema: z.ZodType<T>; schemaName: string }
export type Vision = { describe<T>(p: VisionInput<T>): Promise<T> }

class Retryable extends Error {}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const plain = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)

export function kieVision(apiKey: string, fetchImpl: typeof fetch = fetch, opts: { retryDelayMs?: number } = {}): Vision {
  const retryDelayMs = opts.retryDelayMs ?? 4000

  async function once(body: string): Promise<string> {
    let res: Response
    try {
      res = await fetchImpl(KIE_RESPONSES_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), body })
    } catch (err: any) {
      throw new Retryable(`kie vision không kết nối được: ${err?.message ?? err}`)
    }
    const text = await res.text()
    const trimmed = text.trim()
    if (!res.ok && !trimmed.startsWith('{') && !trimmed.startsWith('event:')) {
      if (res.status >= 500) throw new Retryable(`kie vision HTTP ${res.status} (máy chủ Kie lỗi tạm thời, thử lại sau)`)
      throw new Error(`kie vision HTTP ${res.status}: ${plain(text)}`)
    }
    try {
      return parseResponsesBody(text).text
    } catch (err: any) {
      if (/frequency is too high/i.test(String(err?.message))) throw new Retryable(String(err.message))
      throw err
    }
  }

  return {
    async describe<T>({ model, system, text, images, schema, schemaName }: VisionInput<T>): Promise<T> {
      const body = JSON.stringify({
        model,
        stream: false,
        instructions: system,
        reasoning: { effort: 'low' },
        input: [{ role: 'user', content: [{ type: 'input_text', text }, ...images.map(image_url => ({ type: 'input_image', image_url }))] }],
        text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: z.toJSONSchema(schema as any) } },
      })
      let out = ''
      for (let attempt = 1; ; attempt++) {
        try { out = await once(body); break } catch (err) {
          if (!(err instanceof Retryable) || attempt >= ATTEMPTS) throw new Error((err as Error).message)
          await sleep(retryDelayMs * attempt)
        }
      }
      try { return schema.parse(JSON.parse(out)) } catch (err: any) { throw new Error(`kie vision returned an unparsable ${schemaName}: ${err?.message ?? err}`) }
    },
  }
}
