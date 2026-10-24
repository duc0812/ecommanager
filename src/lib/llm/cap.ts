import { prisma } from '@/lib/db'

export class LlmCapReached extends Error {
  constructor(cap: number) { super(`LLM daily call cap (${cap}) reached`) }
}

function vnDate(now: Date): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10)
}

const keyFor = (now: Date) => `cs.llmCalls.${vnDate(now)}`

export async function llmCallsToday(now = new Date()): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: keyFor(now) } })
  return row ? Number(row.value) || 0 : 0
}

export async function takeLlmCall(cap: number, now = new Date()): Promise<boolean> {
  const key = keyFor(now)
  const current = await llmCallsToday(now)
  if (current >= cap) return false
  const value = String(current + 1)
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  return true
}

export async function withCap<T>(cap: number, fn: () => Promise<T>, now = new Date()): Promise<T> {
  if (!(await takeLlmCall(cap, now))) throw new LlmCapReached(cap)
  return fn()
}
