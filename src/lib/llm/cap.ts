import { prisma } from '@/lib/db'

export class LlmCapReached extends Error {
  constructor(cap: number) { super(`LLM daily call cap (${cap}) reached`) }
}

function vnDate(now: Date): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10)
}

export const CS_CALLS_PREFIX = 'cs.llmCalls'

const keyFor = (now: Date, prefix: string) => `${prefix}.${vnDate(now)}`

/** `prefix` names the daily counter: each caller with its own prefix has its own count and cap. */
export async function llmCallsToday(now = new Date(), prefix = CS_CALLS_PREFIX): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: keyFor(now, prefix) } })
  return row ? Number(row.value) || 0 : 0
}

export async function takeLlmCall(cap: number, now = new Date(), prefix = CS_CALLS_PREFIX): Promise<boolean> {
  const key = keyFor(now, prefix)
  const current = await llmCallsToday(now, prefix)
  if (current >= cap) return false
  const value = String(current + 1)
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  return true
}

export async function withCap<T>(cap: number, fn: () => Promise<T>, now = new Date(), prefix = CS_CALLS_PREFIX): Promise<T> {
  if (!(await takeLlmCall(cap, now, prefix))) throw new LlmCapReached(cap)
  return fn()
}
