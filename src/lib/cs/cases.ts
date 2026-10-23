import { CS_CATEGORIES } from '@/lib/cs/triage'

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export function parseCaseBody(body: any, partial = false): { data: Record<string, unknown> } | { error: string } {
  const data: Record<string, unknown> = {}
  const fields = ['title', 'category', 'situation', 'resolution'] as const
  for (const f of fields) {
    if (body[f] !== undefined || !partial) {
      const v = str(body[f])
      if (!v) return { error: `Thiếu ${f}` }
      data[f] = v
    }
  }
  if (data.category !== undefined && !(CS_CATEGORIES as readonly string[]).includes(data.category as string)) return { error: 'Category không hợp lệ' }
  for (const f of ['toneNotes', 'forbidden', 'exampleReply'] as const) {
    if (body[f] !== undefined) data[f] = str(body[f]) || null
  }
  if (typeof body.active === 'boolean') data.active = body.active
  return { data }
}
