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
  it('another counter prefix has its own key and leaves the CS key alone', async () => {
    const day = new Date('2026-12-02T03:00:00Z')
    await prisma.appSetting.deleteMany({ where: { key: { in: ['cs.llmCalls.2026-12-02', 'lark.llmCalls.2026-12-02'] } } })
    expect(await takeLlmCall(1, day)).toBe(true)
    expect(await takeLlmCall(1, day)).toBe(false)
    expect(await takeLlmCall(2, day, 'lark.llmCalls')).toBe(true)
    await withCap(2, async () => {}, day, 'lark.llmCalls')
    await expect(withCap(2, async () => {}, day, 'lark.llmCalls')).rejects.toBeInstanceOf(LlmCapReached)
    expect(await llmCallsToday(day)).toBe(1)
    expect(await llmCallsToday(day, 'lark.llmCalls')).toBe(2)
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: 'cs.llmCalls.2026-12-02' } })).value).toBe('1')
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: 'lark.llmCalls.2026-12-02' } })).value).toBe('2')
    await prisma.appSetting.deleteMany({ where: { key: { in: ['cs.llmCalls.2026-12-02', 'lark.llmCalls.2026-12-02'] } } })
  })

  it('withCap throws LlmCapReached without calling fn', async () => {
    let called = 0
    await withCap(1, async () => { called += 1 }, now)
    await expect(withCap(1, async () => { called += 1 }, now)).rejects.toBeInstanceOf(LlmCapReached)
    expect(called).toBe(1)
  })
})
