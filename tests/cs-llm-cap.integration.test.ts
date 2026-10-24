import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import { LlmCapReached, llmCallsToday, takeLlmCall, withCap } from '@/lib/llm/cap'

const now = new Date('2026-10-24T03:00:00Z')

beforeEach(async () => { await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'cs.llmCalls.' } } }) })

describe('llm daily cap', () => {
  it('takeLlmCall counts per VN day and refuses at the cap', async () => {
    expect(await takeLlmCall(2, now)).toBe(true)
    expect(await takeLlmCall(2, now)).toBe(true)
    expect(await takeLlmCall(2, now)).toBe(false)
    expect(await llmCallsToday(now)).toBe(2)
    expect(await prisma.appSetting.findUnique({ where: { key: 'cs.llmCalls.2026-10-24' } })).not.toBeNull()
    expect(await takeLlmCall(2, new Date('2026-10-24T17:30:00Z'))).toBe(true)
  })
  it('withCap throws LlmCapReached without calling fn', async () => {
    let called = 0
    await withCap(1, async () => { called += 1 }, now)
    await expect(withCap(1, async () => { called += 1 }, now)).rejects.toBeInstanceOf(LlmCapReached)
    expect(called).toBe(1)
  })
})
