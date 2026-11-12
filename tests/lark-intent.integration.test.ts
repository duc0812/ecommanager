import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { prisma } from '@/lib/db'
import type { Llm } from '@/lib/llm/anthropic'
import { LlmCapReached } from '@/lib/llm/cap'
import { LARK_INTENT_SYSTEM, LarkIntentSchema, larkLlm, parseLarkIntent } from '@/lib/lark/intent'
import { resolveTaskRefs } from '@/lib/lark/resolve'
import { agentFixture } from './helpers/design-agent-fixture'

const fakeLlm = (output: unknown) => ({ complete: vi.fn(async () => ({ output, tokensIn: 1, tokensOut: 1 })) }) as unknown as Llm

const fx = agentFixture('lir')
const fxB = agentFixture('lis')
const KEY_SETTINGS = ['cs.anthropicApiKey', 'cs.kieApiKey']
const savedEnv = { a: process.env.ANTHROPIC_API_KEY, k: process.env.KIE_API_KEY }
const capKey = () => `cs.llmCalls.${new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)}`

beforeAll(async () => {
  await fx.cleanup(); await fxB.cleanup()
  await fx.seed(); await fxB.seed()
  const two = await fx.order(6262, { skus: ['DN1-Hoodie', 'DN2-Tee'] })
  await prisma.designTask.update({ where: { taskKey: two.taskKeys[0] }, data: { status: 'REJECTED' } })
  await prisma.designTask.update({ where: { taskKey: two.taskKeys[1] }, data: { status: 'DONE' } })
  await fx.order(7000)
  await fxB.order(7000)
  await fx.order(8000, { taskStatus: 'CANCELLED' })
})

afterAll(async () => {
  await fx.cleanup(); await fxB.cleanup()
  process.env.ANTHROPIC_API_KEY = savedEnv.a; process.env.KIE_API_KEY = savedEnv.k
  if (savedEnv.a === undefined) delete process.env.ANTHROPIC_API_KEY
  if (savedEnv.k === undefined) delete process.env.KIE_API_KEY
})

describe('Lark intent', () => {
  it('sends the message as data and returns the parsed intent', async () => {
    const llm = fakeLlm({ scope: 'DESIGN_STUDIO', kind: 'FIX', lineKeys: ['LIT6262_1'], instruction: 'sao trên mũ bị lệch' })
    const intent = await parseLarkIntent('LIT6262_1 sửa sao trên mũ bị lệch', { llm, model: 'claude-opus-5-5', cap: 500 })
    expect(intent).toEqual({ scope: 'DESIGN_STUDIO', kind: 'FIX', lineKeys: ['LIT6262_1'], instruction: 'sao trên mũ bị lệch' })
    expect((llm.complete as any).mock.calls[0][0]).toMatchObject({ system: LARK_INTENT_SYSTEM, user: 'LIT6262_1 sửa sao trên mũ bị lệch', model: 'claude-opus-5-5', schema: LarkIntentSchema, schemaName: 'lark_intent' })
  })

  it('the schema only lets the listed values through', () => {
    expect(LarkIntentSchema.safeParse({ scope: 'SHELL', kind: 'FIX', lineKeys: [], instruction: '' }).success).toBe(false)
    expect(LarkIntentSchema.safeParse({ scope: 'DESIGN_STUDIO', kind: 'APPROVE', lineKeys: [], instruction: '' }).success).toBe(false)
    expect(LarkIntentSchema.safeParse({ scope: 'DESIGN_STUDIO', kind: 'FIX', lineKeys: ['A', 'B', 'C', 'D', 'E', 'F'], instruction: '' }).success).toBe(false)
  })

  it('counts against the daily cap', async () => {
    const before = await prisma.appSetting.findUnique({ where: { key: capKey() } })
    await expect(parseLarkIntent('x', { llm: fakeLlm({}), model: 'm', cap: 0 })).rejects.toBeInstanceOf(LlmCapReached)
    await parseLarkIntent('x', { llm: fakeLlm({ scope: 'UNCLEAR', kind: 'OTHER', lineKeys: [], instruction: '' }), model: 'm', cap: 100000 })
    const after = await prisma.appSetting.findUniqueOrThrow({ where: { key: capKey() } })
    expect(Number(after.value)).toBe((Number(before?.value) || 0) + 1)
  })

  it('larkLlm is null without a stored key', async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: KEY_SETTINGS } } })
    delete process.env.ANTHROPIC_API_KEY; delete process.env.KIE_API_KEY
    expect(await larkLlm()).toBeNull()
  })

  it('larkLlm uses the CS agent provider, model and cap', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-lark-intent'; process.env.KIE_API_KEY = 'kie-test-lark-intent'
    const got = await larkLlm()
    expect(got).not.toBeNull()
    expect(got!.model).toBeTruthy(); expect(got!.cap).toBeGreaterThan(0)
    delete process.env.ANTHROPIC_API_KEY; delete process.env.KIE_API_KEY
  })
})

describe('order references', () => {
  it('resolves the three ways of naming a line', async () => {
    expect((await resolveTaskRefs(['LIR6262_1'], 'LIR6262_1 sửa')).tasks.map(t => t.taskKey)).toEqual(['LIR6262_1'])
    expect((await resolveTaskRefs(['#lir6262_2'], '#lir6262 dòng 2')).tasks.map(t => t.taskKey)).toEqual(['LIR6262_2'])
    expect((await resolveTaskRefs(['6262_1'], 'đơn 6262 dòng 1')).tasks.map(t => t.taskKey)).toEqual(['LIR6262_1'])
    expect((await resolveTaskRefs(['LIR 6262_1', 'LIR6262_1'], 'LIR6262_1')).tasks).toHaveLength(1)
  })

  it('an order with several lines, or a number two stores share, is asked back', async () => {
    expect(await resolveTaskRefs(['LIR6262'], 'LIR6262 sửa')).toMatchObject({ tasks: [], ambiguous: [{ ref: 'LIR6262', candidates: ['LIR6262_1', 'LIR6262_2'] }] })
    expect((await resolveTaskRefs(['7000_1'], 'đơn 7000 dòng 1')).ambiguous[0].candidates).toEqual(['LIR7000_1', 'LIS7000_1'])
    expect((await resolveTaskRefs(['LIR7000'], 'LIR7000 sửa')).tasks.map(t => t.taskKey)).toEqual(['LIR7000_1'])
  })

  it('a code that is not in the message, an unknown order and a cancelled task resolve to nothing', async () => {
    expect(await resolveTaskRefs(['LIR6262_1'], 'sửa giúp đơn hôm qua')).toMatchObject({ tasks: [], unknown: ['LIR6262_1'] })
    expect((await resolveTaskRefs(['LIR62621_1'], 'LIR6262_1 sửa')).unknown).toEqual(['LIR62621_1'])
    expect((await resolveTaskRefs(['LIR9999_1'], 'LIR9999_1')).unknown).toEqual(['LIR9999_1'])
    expect((await resolveTaskRefs(['LIR8000'], 'LIR8000')).unknown).toEqual(['LIR8000'])
    expect((await resolveTaskRefs(["LIR6262_1' OR 1=1"], "LIR6262_1' OR 1=1")).unknown).toEqual(["LIR6262_1'OR1=1"])
  })
})
