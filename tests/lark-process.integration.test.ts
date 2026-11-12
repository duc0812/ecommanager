import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const failEnqueue = vi.hoisted(() => ({ on: false }))
vi.mock('@/lib/design-agent/jobs', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/design-agent/jobs')>()
  return {
    ...real,
    enqueueAgentJob: async (input: Parameters<typeof real.enqueueAgentJob>[0]) => {
      if (failEnqueue.on) throw new Error('database is locked')
      return real.enqueueAgentJob(input)
    },
  }
})

import { prisma } from '@/lib/db'
import { loadTask } from '@/lib/design-tasks'
import { saveAgentSettings } from '@/lib/design-settings'
import { LlmError, type Llm } from '@/lib/llm/types'
import { LarkApiError } from '@/lib/lark/api'
import type { AcceptedLarkMessage } from '@/lib/lark/events'
import type { LarkIntent } from '@/lib/lark/intent'
import { processLarkMessage } from '@/lib/lark/process'
import { REPLY_NOT_READ, REPLY_OTHER, REPLY_SENT } from '@/lib/lark/replies'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('lip')
const fakeLlm = (output: unknown) => ({ complete: vi.fn(async () => ({ output, tokensIn: 1, tokensOut: 1 })) }) as unknown as Llm
const fix = (kind: LarkIntent['kind'], lineKeys: string[], instruction = ''): LarkIntent => ({ scope: 'DESIGN_STUDIO', kind, lineKeys, instruction })

const lark = {
  reply: vi.fn<(id: string, text: string) => Promise<void>>(async () => {}),
  sendToChat: vi.fn(async () => {}),
  botOpenId: vi.fn(async () => 'ou_bot' as string | null),
  userName: vi.fn(async () => 'Lan' as string | null),
}
const deps = { lark, llm: { llm: fakeLlm({}), model: 'm', cap: 100000 } }

let seq = 0
function msg(text: string): AcceptedLarkMessage {
  seq++
  return { eventId: `lip-ev-${seq}`, messageId: `lip-om-${seq}`, senderOpenId: 'ou_lan_123456', text: `@_user_1 ${text}`, mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Design Bot' }] }
}
async function insert(m: AcceptedLarkMessage) {
  await prisma.larkEvent.create({ data: { eventId: m.eventId, messageId: m.messageId, senderOpenId: m.senderOpenId, text: m.text } })
  return m
}
async function run(text: string, intent: LarkIntent) {
  const m = await insert(msg(text))
  const r = await processLarkMessage(m, { lark, llm: { llm: fakeLlm(intent), model: 'm', cap: 100000 } })
  return { ...r, eventId: m.eventId }
}
const eventOf = (r: { eventId: string }) => prisma.larkEvent.findUniqueOrThrow({ where: { eventId: r.eventId } })
const jobsOf = (key: string) => prisma.designAgentJob.findMany({ where: { taskKey: key }, orderBy: { createdAt: 'asc' } })
const openJobsOf = (key: string) => prisma.designAgentJob.findMany({ where: { taskKey: key, status: { in: ['QUEUED', 'RUNNING'] } } })
async function lastEvent(key: string) {
  const t = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })
  return prisma.designTaskEvent.findFirstOrThrow({ where: { taskId: t.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
}

beforeAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'LIP' } } })
  await prisma.larkEvent.deleteMany({ where: { eventId: { startsWith: 'lip-' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await fx.cleanup()
  await fx.seed()
  const statuses: Record<number, { taskStatus?: string; exported?: boolean; skus?: string[] }> = {
    1: { taskStatus: 'REJECTED' }, 2: { taskStatus: 'REVIEW' }, 3: { taskStatus: 'DONE' }, 4: { taskStatus: 'DONE', exported: true },
    5: {}, 6: { taskStatus: 'DOING' }, 7: { taskStatus: 'DONE' }, 8: { taskStatus: 'ASK_CUSTOMER' }, 9: { taskStatus: 'REJECTED' },
    10: { taskStatus: 'REJECTED' }, 11: { taskStatus: 'REJECTED' }, 12: { taskStatus: 'REJECTED', skus: ['DN1-Hoodie', 'DN2-Tee'] },
    13: { taskStatus: 'REJECTED' }, 14: { taskStatus: 'REJECTED' }, 15: { taskStatus: 'REVIEW' }, 16: { taskStatus: 'CANCELLED' },
    17: { taskStatus: 'REVIEW' }, 18: { taskStatus: 'DONE' },
  }
  for (const [n, o] of Object.entries(statuses)) await fx.order(Number(n), { ...o, withPrint: true })
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'LIP' } } })
  await prisma.larkEvent.deleteMany({ where: { eventId: { startsWith: 'lip-' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await fx.cleanup()
})

beforeEach(() => {
  lark.reply.mockClear(); lark.sendToChat.mockClear()
  lark.reply.mockImplementation(async () => {})
})

describe('Lark message processing', () => {
  it('out of scope, unclear, other: a one-line reply and no job', async () => {
    expect((await run('doanh thu hôm nay?', { scope: 'OUT_OF_SCOPE', kind: 'OTHER', lineKeys: [], instruction: '' })).reply).toBe('Bot chỉ nhận việc của Design Studio (sửa mẫu, làm mẫu, mockup).')
    expect((await run('sửa giúp cái đơn kia', { scope: 'UNCLEAR', kind: 'FIX', lineKeys: [], instruction: '' })).reply).toBe('Chưa rõ đơn nào. Hãy gửi mã đơn và dòng, ví dụ: LIT6262_1.')
    const other = await run('LIP1_1 là gì', fix('OTHER', ['LIP1_1']))
    expect(other).toMatchObject({ outcome: 'REPLIED', reply: REPLY_OTHER, jobIds: [] })
    expect(await prisma.designAgentJob.count({ where: { taskKey: { startsWith: 'LIP' } } })).toBe(0)
    expect(lark.reply).toHaveBeenCalledTimes(3)
    expect(lark.reply).toHaveBeenLastCalledWith(other.eventId.replace('ev', 'om'), REPLY_OTHER)
  })

  it('an empty message after the mention gets the help text without a Claude call', async () => {
    const m = await insert(msg('   '))
    const llm = fakeLlm(fix('FIX', []))
    expect(await processLarkMessage(m, { lark, llm: { llm, model: 'm', cap: 100000 } })).toMatchObject({ outcome: 'REPLIED', reply: REPLY_OTHER })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('FIX on a rejected task: one LARK job, also with autoFixOnReject off', async () => {
    await saveAgentSettings({ autoFixOnReject: false })
    const r = await run('LIP1_1 sửa sao trên mũ bị lệch', fix('FIX', ['LIP1_1'], 'sao trên mũ bị lệch'))
    expect(r).toMatchObject({ outcome: 'JOB', reply: 'Đã nhận: LIP1_1 — sao trên mũ bị lệch. Kết quả xem trên tool.' })
    expect(await jobsOf('LIP1_1')).toMatchObject([{ kind: 'FIX', source: 'LARK', requestedBy: 'Lan', requestText: 'Yêu cầu từ Lark (Lan): sao trên mũ bị lệch' }])
    expect(await eventOf(r)).toMatchObject({ outcome: 'JOB', senderName: 'Lan', jobIds: JSON.stringify([r.jobIds[0]]), reply: r.reply, error: null })
  })

  it('a second message for the same task is appended, then noted once the job runs', async () => {
    const appended = await run('LIP1_1 viền tay áo nữa', fix('FIX', ['LIP1_1'], 'viền tay áo'))
    expect(appended).toMatchObject({ outcome: 'JOB', reply: 'Đã thêm vào yêu cầu đang chờ của LIP1_1. Kết quả xem trên tool.' })
    expect((await jobsOf('LIP1_1'))[0].requestText).toBe('Yêu cầu từ Lark (Lan): sao trên mũ bị lệch\nLan: Yêu cầu từ Lark (Lan): viền tay áo')
    await prisma.designAgentJob.updateMany({ where: { taskKey: 'LIP1_1' }, data: { status: 'RUNNING' } })
    const noted = await run('LIP1_1 thêm logo', fix('FIX', ['LIP1_1'], 'thêm logo'))
    expect(noted).toMatchObject({ outcome: 'REPLIED', jobIds: [], reply: 'Agent đang làm LIP1_1. Đã ghi yêu cầu vào ghi chú của task; nếu kết quả chưa đúng hãy trả lại trên tool.' })
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'LIP1_1' } })).toBe(1)
    expect((await lastEvent('LIP1_1')).message).toBe('Agent: Lark – Lan: thêm logo')
  })

  it('FIX on a task in review rejects it as Design Agent first; one open job with the switch off', async () => {
    await saveAgentSettings({ autoFixOnReject: false })
    const r = await run('LIP2_1 sai màu nền', fix('FIX', ['LIP2_1'], 'sai màu nền'))
    expect(r).toMatchObject({ outcome: 'JOB', reply: 'Đã nhận: LIP2_1 — sai màu nền. Kết quả xem trên tool.' })
    expect((await loadTask('LIP2_1'))!.task).toMatchObject({ status: 'REJECTED', rejectReasons: ['Khác: sai màu nền'], rejectNote: 'Theo yêu cầu của Lan trên Lark' })
    expect(await jobsOf('LIP2_1')).toHaveLength(1)
    expect(await openJobsOf('LIP2_1')).toMatchObject([{ id: r.jobIds[0], kind: 'FIX', requestText: 'Yêu cầu từ Lark (Lan): sai màu nền' }])
  })

  it('FIX on a task in review with autoFixOnReject on still ends as exactly one open job', async () => {
    await saveAgentSettings({ autoFixOnReject: true })
    const r = await run('LIP15_1 sai màu nền', fix('FIX', ['LIP15_1'], 'sai màu nền'))
    expect(r.outcome).toBe('JOB'); expect(r.jobIds).toHaveLength(1)
    expect((await loadTask('LIP15_1'))!.task.status).toBe('REJECTED')
    const open = await openJobsOf('LIP15_1')
    expect(open).toHaveLength(1); expect(open[0].id).toBe(r.jobIds[0]); expect(open[0].requestText).toContain('Yêu cầu từ Lark (Lan): sai màu nền')
    await saveAgentSettings({ autoFixOnReject: false })
  })

  it('FIX on an approved task: reopened when not sent, refused when sent', async () => {
    await run('LIP3_1 sửa chữ', fix('FIX', ['LIP3_1'], 'sửa chữ'))
    expect((await loadTask('LIP3_1'))!.task.status).toBe('DOING'); expect(await jobsOf('LIP3_1')).toHaveLength(1)
    expect((await run('LIP4_1 sửa chữ', fix('FIX', ['LIP4_1'], 'sửa chữ'))).reply).toBe(REPLY_SENT)
    expect(await jobsOf('LIP4_1')).toEqual([]); expect((await loadTask('LIP4_1'))!.task.status).toBe('DONE')
  })

  it('NEW_DESIGN is MAKE on a new task and FIX elsewhere; MOCKUP never moves the task', async () => {
    const made = await run('LIP5_1 làm mẫu', fix('NEW_DESIGN', ['LIP5_1']))
    expect(made.reply).toBe('Đã nhận: LIP5_1. Kết quả xem trên tool.')
    expect((await jobsOf('LIP5_1'))[0].kind).toBe('MAKE')
    await run('LIP6_1 làm lại mẫu', fix('NEW_DESIGN', ['LIP6_1'], 'làm lại mẫu')); expect((await jobsOf('LIP6_1'))[0].kind).toBe('FIX')
    await run('LIP7_1 làm mockup', fix('MOCKUP', ['LIP7_1'])); expect((await jobsOf('LIP7_1'))[0].kind).toBe('MOCKUP')
    expect((await loadTask('LIP7_1'))!.task.status).toBe('DONE')
  })

  it('statuses without a rule and a fix without a description get a reply, not a job', async () => {
    expect((await run('LIP8_1 sửa', fix('FIX', ['LIP8_1'], 'sửa chữ'))).reply).toBe('LIP8_1 đang chờ khách trả lời — bấm Tiếp tục trên tool rồi nhắn lại.')
    expect((await run('LIP9_1 sửa', fix('FIX', ['LIP9_1'], ''))).reply).toBe('Cần sửa gì ở LIP9_1? Hãy ghi rõ chỗ sai.')
    expect((await run('LIP16_1 sửa', fix('FIX', ['LIP16_1'], 'sửa chữ'))).reply).toBe('LIP16_1 đã huỷ, không nhận yêu cầu.')
    expect(await prisma.designAgentJob.count({ where: { taskKey: { in: ['LIP8_1', 'LIP9_1', 'LIP16_1'] } } })).toBe(0)
  })

  it('several lines in one message: one job each, one reply', async () => {
    const r = await run('LIP10_1 và LIP11_1 sửa viền', fix('FIX', ['LIP10_1', 'LIP11_1'], 'sửa viền'))
    expect(r.jobIds).toHaveLength(2); expect(r.reply!.split('\n')).toHaveLength(2); expect(lark.reply).toHaveBeenCalledTimes(1)
  })

  it('an order with two lines is asked back', async () => {
    const r = await run('LIP12 sửa viền', fix('FIX', ['LIP12'], 'sửa viền'))
    expect(r).toMatchObject({ outcome: 'REPLIED', reply: 'LIP12 có nhiều dòng: LIP12_1, LIP12_2. Hãy ghi rõ dòng cần làm.' })
    expect(await prisma.designAgentJob.count({ where: { taskKey: { startsWith: 'LIP12' } } })).toBe(0)
  })

  it('a code the model invented is not used', async () => {
    const r = await run('sửa giúp đơn hôm qua', fix('FIX', ['LIP14_1'], 'sửa viền'))
    expect(r.reply).toBe('Chưa rõ đơn nào. Hãy gửi mã đơn và dòng, ví dụ: LIT6262_1.')
    expect(await jobsOf('LIP14_1')).toEqual([])
  })

  it('Claude unavailable: the designer is told, the event says ERROR, no job', async () => {
    const m = await insert(msg('LIP13_1 sửa'))
    const r = await processLarkMessage(m, { lark, llm: null })
    expect(r).toMatchObject({ outcome: 'ERROR', reply: REPLY_NOT_READ, jobIds: [] })
    expect(await eventOf(m)).toMatchObject({ outcome: 'ERROR', error: 'Chưa có API key cho Claude', reply: REPLY_NOT_READ })
    const boom = { ...deps, llm: { llm: { complete: async () => { throw new LlmError('unparsable lark_intent') } } as any, model: 'm', cap: 500 } }
    const m2 = await insert(msg('LIP13_1 sửa'))
    expect((await processLarkMessage(m2, boom)).outcome).toBe('ERROR')
    expect((await eventOf(m2)).error).toBe('unparsable lark_intent')
    const capped = await insert(msg('LIP13_1 sửa'))
    expect((await processLarkMessage(capped, { lark, llm: { llm: fakeLlm(fix('FIX', ['LIP13_1'], 'sửa')), model: 'm', cap: 0 } })).outcome).toBe('ERROR')
    const junk = await insert(msg('LIP13_1 sửa'))
    expect((await processLarkMessage(junk, { lark, llm: { llm: fakeLlm({ scope: 'RUN_SHELL', kind: 'FIX', lineKeys: ['LIP13_1'], instruction: 'x' }), model: 'm', cap: 100000 } })).outcome).toBe('ERROR')
    expect(await jobsOf('LIP13_1')).toEqual([])
  })

  it('a failing reply keeps the job and records the error', async () => {
    lark.reply.mockRejectedValueOnce(new LarkApiError('Lark /reply: 230002 bot not in chat'))
    const r = await run('LIP14_1 sửa viền', fix('FIX', ['LIP14_1'], 'sửa viền'))
    expect(r.outcome).toBe('JOB'); expect(await jobsOf('LIP14_1')).toHaveLength(1)
    expect(await eventOf(r)).toMatchObject({ outcome: 'JOB', error: expect.stringContaining('230002') })
  })

  it('a mention of someone else is not for the bot', async () => {
    const m = await insert({ ...msg('LIP1_1 sửa'), mentions: [{ key: '@_user_1', openId: 'ou_someone', name: 'Huong' }] })
    const r = await processLarkMessage(m, deps)
    expect(r).toMatchObject({ outcome: 'IGNORED', reply: null }); expect(lark.reply).not.toHaveBeenCalled()
    expect((await eventOf(m)).outcome).toBe('IGNORED')
  })

  it('an unknown bot id counts as mentioned; an unknown sender name falls back to the open id tail', async () => {
    lark.botOpenId.mockRejectedValueOnce(new LarkApiError('Lark /open-apis/bot/v3/info: 99991663 x'))
    lark.userName.mockResolvedValueOnce(null)
    const m = await insert({ ...msg('LIP1_1 là gì'), mentions: [{ key: '@_user_1', openId: 'ou_someone', name: 'Huong' }] })
    const r = await processLarkMessage(m, { lark, llm: { llm: fakeLlm(fix('OTHER', ['LIP1_1'])), model: 'm', cap: 100000 } })
    expect(r.outcome).toBe('REPLIED')
    expect((await eventOf(m)).senderName).toBe('Lark 123456')
  })

  it('a reject or reopen that cannot be followed by a job leaves a note and says so', async () => {
    failEnqueue.on = true
    try {
      const rejected = await run('LIP17_1 sai màu nền', fix('FIX', ['LIP17_1'], 'sai màu nền'))
      expect(rejected).toMatchObject({ outcome: 'REPLIED', jobIds: [], reply: 'LIP17_1: đã trả lại task nhưng chưa xếp được việc cho Agent — hãy xếp lại trên tool.' })
      expect((await loadTask('LIP17_1'))!.task.status).toBe('REJECTED')
      expect((await lastEvent('LIP17_1')).message).toBe('Agent: không xếp được việc sau khi trả lại sửa theo yêu cầu Lark; cần xếp lại')
      expect((await eventOf(rejected)).error).toContain('database is locked')
      const reopened = await run('LIP18_1 sửa chữ', fix('FIX', ['LIP18_1'], 'sửa chữ'))
      expect(reopened.reply).toBe('LIP18_1: đã mở lại task nhưng chưa xếp được việc cho Agent — hãy xếp lại trên tool.')
      expect((await loadTask('LIP18_1'))!.task.status).toBe('DOING')
      expect((await lastEvent('LIP18_1')).message).toBe('Agent: không xếp được việc sau khi mở lại để sửa theo yêu cầu Lark; cần xếp lại')
      expect(await prisma.designAgentJob.count({ where: { taskKey: { in: ['LIP17_1', 'LIP18_1'] } } })).toBe(0)
    } finally {
      failEnqueue.on = false
    }
  })
})
