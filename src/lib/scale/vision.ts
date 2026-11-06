import { z } from 'zod'
import { parseResponsesBody } from '@/lib/llm/kie-responses'

const KIE_RESPONSES_URL = 'https://api.kie.ai/openai/v1/responses'

export type VisionInput<T> = { model: string; system: string; text: string; images: string[]; schema: z.ZodType<T>; schemaName: string }
export type Vision = { describe<T>(p: VisionInput<T>): Promise<T> }

export function kieVision(apiKey: string, fetchImpl: typeof fetch = fetch): Vision {
  return {
    async describe<T>({ model, system, text, images, schema, schemaName }: VisionInput<T>): Promise<T> {
      const res = await fetchImpl(KIE_RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          instructions: system,
          reasoning: { effort: 'low' },
          input: [{ role: 'user', content: [{ type: 'input_text', text }, ...images.map(image_url => ({ type: 'input_image', image_url }))] }],
          text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: z.toJSONSchema(schema as any) } },
        }),
      })
      const body = await res.text()
      const trimmed = body.trim()
      if (!res.ok && !trimmed.startsWith('{') && !trimmed.startsWith('event:')) throw new Error(`kie vision HTTP ${res.status}: ${body.slice(0, 200)}`)
      const { text: out } = parseResponsesBody(body)
      try { return schema.parse(JSON.parse(out)) } catch (err: any) { throw new Error(`kie vision returned an unparsable ${schemaName}: ${err?.message ?? err}`) }
    },
  }
}
