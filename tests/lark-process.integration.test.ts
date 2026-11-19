import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest'

const failEnqueue = vi.hoisted(() => ({ on: false }))
const failResolve = vi.hoisted(() => ({ on: false }))
vi.mock('@/lib/lark/resolve', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/lark/resolve')>()
  return {
    ...real,
    resolveTaskRefs: async (...args: Parameters<typeof real.resolveTaskRefs>) => {
      if (failResolve.on) throw new Error('database is locked')
      return real.resolveTaskRefs(...args)
    },
  }
})
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
import type { BoardEntryInput } from '@/lib/design-agent/work-board'
import type { AcceptedLarkMessage } from '@/lib/lark/events'
import type { LarkIntent } from '@/lib/lark/intent'
import { processLarkMessage } from '@/lib/lark/process'
import { LARK_DAILY_CALL_CAP } from '@/lib/lark/intent'
import { LlmCapReached } from '@/lib/llm/cap'
import { REPLY_BOARD_STALE_REPORT, REPLY_FAILED, REPLY_LIST_CAP, REPLY_NOT_READ, REPLY_OTHER, REPLY_OUT_OF_SCOPE, REPLY_SENT } from '@/lib/lark/replies'
import { agentFixture } from './helpers/design-agent-fixture'
import { dropWorkBoard, publishBoard } from './helpers/work-board'

const fx = agentFixture('lip')
const fakeLlm = (output: unknown) => ({ complete: vi.fn(async () => ({ output, tokensIn: 1, tokensOut: 1 })) }) as unknown as Llm
const fix = (kind: LarkIntent['kind'], lineKeys: string[], instruction = ''): LarkIntent => ({ scope: 'DESIGN_STUDIO', kind, lineKeys, instruction, supplierName: '', supplierSku: '' })

const lark = {
  reply: vi.fn<(id: string, text: string) => Promise<void>>(async () => {}),
  sendToChat: vi.fn(async () => {}),
  botOpenId: vi.fn(async () => 'ou_bot' as string | null),
  userName: vi.fn(async () => 'Lan' as string | null),
}
const deps = { lark, llm: { llm: fakeLlm({}), model: 'm', cap: 100000 } }

const LIST_ORDERS = Array.from({ length: 14 }, (_, i) => 32 + i)
const LIST_KEYS = LIST_ORDERS.map(n => `LIP${n}_1`)

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
  await publishBoard()
  const statuses: Record<number, { taskStatus?: string; exported?: boolean; skus?: string[]; pipelineStatus?: string }> = {
    1: { taskStatus: 'REJECTED' }, 2: { taskStatus: 'REVIEW' }, 3: { taskStatus: 'DONE' }, 4: { taskStatus: 'DONE', exported: true },
    5: {}, 6: { taskStatus: 'DOING' }, 7: { taskStatus: 'DONE' }, 8: { taskStatus: 'ASK_CUSTOMER' }, 9: { taskStatus: 'REJECTED' },
    10: { taskStatus: 'REJECTED' }, 11: { taskStatus: 'REJECTED' }, 12: { taskStatus: 'REJECTED', skus: ['DN1-Hoodie', 'DN2-Tee'] },
    13: { taskStatus: 'REJECTED' }, 14: { taskStatus: 'REJECTED' }, 15: { taskStatus: 'REVIEW' }, 16: { taskStatus: 'CANCELLED' },
    17: { taskStatus: 'REVIEW' }, 18: { taskStatus: 'DONE' },
    19: { taskStatus: 'REJECTED', pipelineStatus: 'FULFILLED' }, 20: { taskStatus: 'DONE', pipelineStatus: 'CANCELLED' },
    21: { taskStatus: 'REVIEW' }, 22: { taskStatus: 'DONE' }, 23: { taskStatus: 'REJECTED' }, 24: { taskStatus: 'DOING' },
    25: { taskStatus: 'NEW' }, 26: { taskStatus: 'REJECTED' }, 27: { taskStatus: 'DONE', exported: true }, 28: { taskStatus: 'REJECTED' },
    29: { taskStatus: 'REVIEW' }, 30: { taskStatus: 'REJECTED' }, 46: { taskStatus: 'REVIEW' }, 47: { taskStatus: 'REVIEW' },
  }
  for (const n of [31, ...LIST_ORDERS, 48, 49]) statuses[n] = { taskStatus: 'REJECTED' }
  for (const [n, o] of Object.entries(statuses)) await fx.order(Number(n), { ...o, withPrint: true })
  const hoa = await fx.user('Hoa', 'SUPPORT', ['design_tasks'])
  await prisma.designTask.update({ where: { taskKey: 'LIP24_1' }, data: { assigneeId: hoa.actor.id } })
  await prisma.designTask.update({ where: { taskKey: 'LIP25_1' }, data: { readiness: 'AUTO' } })
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'LIP' } } })
  await prisma.larkEvent.deleteMany({ where: { eventId: { startsWith: 'lip-' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await dropWorkBoard()
  await fx.cleanup()
})

beforeEach(() => {
  lark.reply.mockClear(); lark.sendToChat.mockClear()
  lark.reply.mockImplementation(async () => {})
})

describe('Lark message processing', () => {
  it('out of scope, unclear, other: a one-line reply and no job', async () => {
    expect((await run('doanh thu hôm nay?', { ...fix('OTHER', []), scope: 'OUT_OF_SCOPE' })).reply).toBe(REPLY_OUT_OF_SCOPE)
    expect((await run('sửa giúp cái đơn kia', { ...fix('FIX', []), scope: 'UNCLEAR' })).reply).toBe('Chưa rõ đơn nào. Hãy gửi mã đơn và dòng, ví dụ: LIT6262_1.')
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
    expect(r).toMatchObject({ outcome: 'JOB', reply: 'LIP1_1: đã nhận, Agent đang làm. Kết quả xem trên tool.' })
    expect(await jobsOf('LIP1_1')).toMatchObject([{ kind: 'FIX', source: 'LARK', requestedBy: 'Lan', requestText: 'Yêu cầu từ Lark (Lan): sao trên mũ bị lệch' }])
    expect(await eventOf(r)).toMatchObject({ outcome: 'JOB', senderName: 'Lan', jobIds: JSON.stringify([r.jobIds[0]]), reply: r.reply, error: null })
  })

  it('a second message for the same task is appended, then noted once the job runs', async () => {
    const appended = await run('LIP1_1 viền tay áo nữa', fix('FIX', ['LIP1_1'], 'viền tay áo'))
    expect(appended).toMatchObject({ outcome: 'JOB', reply: 'LIP1_1: đã thêm vào yêu cầu đang chờ.' })
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
    expect(r).toMatchObject({ outcome: 'JOB', reply: 'LIP2_1: đã nhận, Agent đang làm. Kết quả xem trên tool.' })
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

  it('a fulfilled or closed order gets a reply, not a job, and is not moved', async () => {
    expect((await run('LIP19_1 sửa chữ', fix('FIX', ['LIP19_1'], 'sửa chữ'))).reply).toBe('LIP19_1: đơn đã giao hoặc đã đóng — không nhận yêu cầu.')
    expect((await run('LIP20_1 sửa chữ', fix('FIX', ['LIP20_1'], 'sửa chữ'))).reply).toBe('LIP20_1: đơn đã giao hoặc đã đóng — không nhận yêu cầu.')
    expect((await run('LIP19_1 làm mockup', fix('MOCKUP', ['LIP19_1']))).reply).toBe('LIP19_1: đơn đã giao hoặc đã đóng — không nhận yêu cầu.')
    expect(await prisma.designAgentJob.count({ where: { taskKey: { in: ['LIP19_1', 'LIP20_1'] } } })).toBe(0)
    expect((await loadTask('LIP19_1'))!.task.status).toBe('REJECTED'); expect((await loadTask('LIP20_1'))!.task.status).toBe('DONE')
  })

  it('NEW_DESIGN is MAKE on a new task and FIX elsewhere; MOCKUP never moves the task', async () => {
    const made = await run('LIP5_1 làm mẫu', fix('NEW_DESIGN', ['LIP5_1']))
    expect(made.reply).toBe('LIP5_1: đã nhận, Agent đang làm. Kết quả xem trên tool.')
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
    expect(r.jobIds).toHaveLength(2); expect(lark.reply).toHaveBeenCalledTimes(1)
    expect(r.reply).toBe('Đã nhận 2 dòng, Agent làm lần lượt: LIP10_1, LIP11_1.\nKết quả xem trên tool.')
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
    expect((await processLarkMessage(junk, { lark, llm: { llm: fakeLlm({ ...fix('FIX', ['LIP13_1'], 'x'), scope: 'RUN_SHELL' }), model: 'm', cap: 100000 } })).outcome).toBe('ERROR')
    expect(await jobsOf('LIP13_1')).toEqual([])
  })

  it('a throw while processing records ERROR with the error and sends one generic reply', async () => {
    failResolve.on = true
    try {
      const r = await run('LIP1_1 sửa nền', fix('FIX', ['LIP1_1'], 'sửa nền'))
      expect(r).toMatchObject({ outcome: 'ERROR', jobIds: [], reply: REPLY_FAILED })
      expect(lark.reply).toHaveBeenCalledTimes(1); expect(lark.reply).toHaveBeenCalledWith(expect.any(String), REPLY_FAILED)
      expect(await eventOf(r)).toMatchObject({ outcome: 'ERROR', reply: REPLY_FAILED, error: 'database is locked' })
      lark.reply.mockClear()
      lark.reply.mockImplementation(async () => { throw new LarkApiError('Lark /reply: 99991663 token expired') })
      const quiet = await run('LIP1_1 sửa nền', fix('FIX', ['LIP1_1'], 'sửa nền'))
      expect(quiet).toMatchObject({ outcome: 'ERROR', reply: null })
      expect((await eventOf(quiet)).outcome).toBe('ERROR'); expect((await eventOf(quiet)).error).toContain('database is locked')
    } finally {
      failResolve.on = false
    }
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

describe('Lark requests on a line someone else holds', () => {
  const NOW = new Date('2026-11-19T10:00:00.000Z')
  const NOTED = ' Yêu cầu của bạn đã được ghi vào task.'
  const UNKNOWN = 'chưa xác định được ai đang giữ vì dữ liệu từ máy local chưa cập nhật. Bot chưa tạo việc.'
  const waiting = (key: string, over: Partial<BoardEntryInput> = {}): BoardEntryInput =>
    ({ taskKey: key, source: 'LOCAL_QUEUE', worker: 'Hàng duyệt local', state: 'waiting', version: 2, etaAt: new Date(NOW.getTime() + 7 * 60_000).toISOString(), ...over })
  const notesOf = async (key: string) => {
    const t = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })
    return (await prisma.designTaskEvent.findMany({ where: { taskId: t.id, type: 'NOTE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(e => e.message)
  }
  const eventCount = async (key: string) => {
    const t = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })
    return prisma.designTaskEvent.count({ where: { taskId: t.id } })
  }
  async function runAt(text: string, intent: LarkIntent, now = NOW) {
    const m = await insert(msg(text))
    return processLarkMessage(m, { lark, llm: { llm: fakeLlm(intent), model: 'm', cap: 100000 }, now })
  }

  afterEach(async () => { await publishBoard() })

  it('busy line gets the local-fix reply, one note, no job and no status change', async () => {
    await publishBoard([waiting('LIP21_1')], null, NOW)
    const before = await eventCount('LIP21_1')
    const review = await runAt('LIP21_1 sai màu nền', fix('FIX', ['LIP21_1'], 'sai màu nền'))
    expect(review).toMatchObject({ outcome: 'REPLIED', jobIds: [], reply: `LIP21_1: đã có bản sửa v2 ở hàng duyệt local, khoảng 7 phút nữa tự lên cloud.${NOTED}` })
    expect((await loadTask('LIP21_1'))!.task).toMatchObject({ status: 'REVIEW', rejectReasons: [] })
    expect(await jobsOf('LIP21_1')).toEqual([])
    expect(await notesOf('LIP21_1')).toEqual(['Agent: Lark – Lan: sai màu nền'])
    expect(await eventCount('LIP21_1')).toBe(before + 1)

    await dropWorkBoard()
    const done = await runAt('LIP22_1 sửa chữ', fix('FIX', ['LIP22_1'], 'sửa chữ'))
    expect(done).toMatchObject({ outcome: 'REPLIED', jobIds: [], reply: `LIP22_1: ${UNKNOWN}${NOTED}` })
    expect((await loadTask('LIP22_1'))!.task.status).toBe('DONE')
    expect(await jobsOf('LIP22_1')).toEqual([])
    expect(await notesOf('LIP22_1')).toEqual(['Agent: Lark – Lan: sửa chữ'])
  })

  it('a queue line past its deadline says lượt quét tới and is still not taken', async () => {
    await publishBoard([waiting('LIP29_1', { etaAt: new Date(NOW.getTime() - 60_000).toISOString() })], null, NOW)
    const r = await runAt('LIP29_1 sai màu nền', fix('FIX', ['LIP29_1'], 'sai màu nền'))
    expect(r.reply).toBe(`LIP29_1: đã có bản sửa v2 ở hàng duyệt local, sẽ lên cloud ở lượt quét tới (tối đa 10 phút).${NOTED}`)
    expect((await loadTask('LIP29_1'))!.task.status).toBe('REVIEW'); expect(await jobsOf('LIP29_1')).toEqual([])
  })

  it('a stream, a designer and auto render each keep their line; no job is made', async () => {
    await publishBoard([], 'Luồng 7', NOW)
    expect((await runAt('LIP23_1 sửa viền', fix('FIX', ['LIP23_1'], 'sửa viền'))).reply).toBe(`LIP23_1: Luồng 7 đang giữ dòng này.${NOTED}`)
    expect((await runAt('LIP24_1 sửa viền', fix('NEW_DESIGN', ['LIP24_1'], 'sửa viền'))).reply).toBe(`LIP24_1: Hoa đang làm dòng này.${NOTED}`)
    expect((await runAt('LIP25_1 làm mẫu', fix('NEW_DESIGN', ['LIP25_1'], 'làm mẫu'))).reply).toBe(`LIP25_1: auto render sẽ xử lý ở lượt hằng giờ.${NOTED}`)
    expect(await prisma.designAgentJob.count({ where: { taskKey: { in: ['LIP23_1', 'LIP24_1', 'LIP25_1'] } } })).toBe(0)
    expect((await loadTask('LIP23_1'))!.task.status).toBe('REJECTED'); expect((await loadTask('LIP24_1'))!.task.status).toBe('DOING'); expect((await loadTask('LIP25_1'))!.task.status).toBe('NEW')
  })

  it('a busy line with nothing to note gets the state alone', async () => {
    await publishBoard([], 'Luồng 7', NOW)
    const notes = await notesOf('LIP23_1')
    expect((await runAt('LIP23_1 làm mockup', fix('MOCKUP', ['LIP23_1']))).reply).toBe('LIP23_1: Luồng 7 đang giữ dòng này.')
    expect(await notesOf('LIP23_1')).toEqual(notes); expect(await jobsOf('LIP23_1')).toEqual([])
  })

  it('a stale or never-published board makes no job and never says the line is free', async () => {
    await publishBoard([], null, new Date(NOW.getTime() - 601_000))
    const stale = await runAt('LIP28_1 sửa viền', fix('FIX', ['LIP28_1'], 'sửa viền'))
    expect(stale).toMatchObject({ outcome: 'REPLIED', jobIds: [], reply: `LIP28_1: ${UNKNOWN}${NOTED}` })
    await dropWorkBoard()
    expect((await runAt('LIP28_1 làm mockup', fix('MOCKUP', ['LIP28_1']))).reply).toBe(`LIP28_1: ${UNKNOWN}`)
    expect((await runAt('việc nào chưa có người làm', fix('UNASSIGNED_REPORT', []))).reply).toBe(REPLY_BOARD_STALE_REPORT)
    expect(await jobsOf('LIP28_1')).toEqual([]); expect((await loadTask('LIP28_1'))!.task.status).toBe('REJECTED')
  })

  it('a free line that was held before is accepted, with the old reason', async () => {
    await publishBoard([waiting('LIP26_1', { state: 'held', detail: 'Thiếu mockup' })])
    const r = await runAt('LIP26_1 sửa chữ', fix('FIX', ['LIP26_1'], 'sửa chữ'), new Date())
    expect(r).toMatchObject({ outcome: 'JOB', reply: 'LIP26_1: đã nhận, Agent đang làm. Kết quả xem trên tool. Dòng này từng bị giữ: Thiếu mockup' })
    expect(await jobsOf('LIP26_1')).toMatchObject([{ kind: 'FIX', source: 'LARK' }])
  })

  it('a sent line answers the same for every kind, mockup included', async () => {
    for (const kind of ['FIX', 'NEW_DESIGN', 'MOCKUP'] as const) expect((await runAt('LIP27_1 làm lại', fix(kind, ['LIP27_1'], 'làm lại'))).reply).toBe(REPLY_SENT)
    expect(await jobsOf('LIP27_1')).toEqual([]); expect((await loadTask('LIP27_1'))!.task.status).toBe('DONE')
  })

  it('a supplier change or undo is answered by the supplier-change path, never with a job', async () => {
    const change = await runAt('LIP30_1 đổi qua Xưởng Không Có', { ...fix('SUPPLIER_CHANGE', ['LIP30_1'], 'đổi qua Xưởng Không Có'), supplierName: 'Xưởng Không Có', supplierSku: 'JM-1' })
    expect(change).toMatchObject({ outcome: 'REPLIED', reply: 'LIP30_1: không tìm thấy xưởng "Xưởng Không Có".', jobIds: [] })
    expect((await runAt('LIP30_1 hoàn tác đổi xưởng', fix('SUPPLIER_UNDO', ['LIP30_1']))).reply).toBe('LIP30_1: chưa có lần chuyển xưởng nào qua Lark để hoàn tác.')
    expect(await jobsOf('LIP30_1')).toEqual([])
  })

  it('a status question answers for the line and makes no job', async () => {
    await publishBoard([], 'Luồng 7', NOW)
    const r = await runAt('LIP30_1 sao rồi', fix('STATUS', ['LIP30_1']))
    expect(r.outcome).toBe('REPLIED'); expect(r.jobIds).toEqual([])
    expect(r.reply).toContain('LIP30_1 — Bị trả lại'); expect(r.reply).toContain('LIP30_1: Luồng 7 đang giữ dòng này.')
    expect(await jobsOf('LIP30_1')).toEqual([])
    expect((await runAt('sao rồi', fix('STATUS', []))).reply).toBe('Chưa rõ đơn nào. Hãy gửi mã đơn và dòng, ví dụ: LIT6262_1.')
  })

  it('the unassigned report needs no line', async () => {
    await publishBoard([], null, NOW)
    const r = await runAt('việc nào chưa có người làm', fix('UNASSIGNED_REPORT', []))
    expect(r.outcome).toBe('REPLIED'); expect(r.jobIds).toEqual([])
    expect(r.reply!.split('\n')[0]).toMatch(/^(Việc chưa có người làm: \d+ dòng\.|Hiện không còn việc nào chưa có người làm\.)$/)
  })
})

describe('Lark line lists and short replies', () => {
  const HOLDER_UNKNOWN = 'chưa rõ ai đang giữ'
  async function runAt(text: string, intent: LarkIntent, now: Date) {
    const m = await insert(msg(text))
    return processLarkMessage(m, { lark, llm: { llm: fakeLlm(intent), model: 'm', cap: 100000 }, now })
  }

  afterEach(async () => { await publishBoard() })

  it('accepted reply is short', async () => {
    const instruction = 'sửa sao trên mũ bị lệch sang trái, đổi màu viền tay áo cho giống mockup'
    const r = await run(`LIP31_1 ${instruction}`, fix('FIX', ['LIP31_1'], instruction))
    expect(r).toMatchObject({ outcome: 'JOB', reply: 'LIP31_1: đã nhận, Agent đang làm. Kết quả xem trên tool.' })
    expect(r.reply).not.toContain('sao trên mũ')
    expect((await jobsOf('LIP31_1'))[0].requestText).toBe(`Yêu cầu từ Lark (Lan): ${instruction}`)
  })

  it('list of 14 lines gives one grouped reply', async () => {
    const r = await run(`${LIST_KEYS.join(', ')} sửa viền cổ`, fix('FIX', LIST_KEYS, 'sửa viền cổ'))
    expect(r.outcome).toBe('JOB'); expect(r.jobIds).toHaveLength(14)
    expect(r.reply).toBe(`Đã nhận 14 dòng, Agent làm lần lượt: ${LIST_KEYS.join(', ')}.\nKết quả xem trên tool.`)
    expect(lark.reply).toHaveBeenCalledTimes(1); expect(lark.reply).toHaveBeenCalledWith(expect.any(String), r.reply)
    expect(r.reply).not.toContain('sửa viền cổ')
    expect(await prisma.designAgentJob.count({ where: { taskKey: { in: LIST_KEYS }, source: 'LARK', kind: 'FIX', status: 'QUEUED' } })).toBe(14)
    expect((await eventOf(r)).reply).toBe(r.reply)
  })

  it('busy, closed and unknown lines land in their groups', async () => {
    const now = new Date()
    const queued = (key: string, minutes: number): BoardEntryInput =>
      ({ taskKey: key, source: 'LOCAL_QUEUE', worker: 'Hàng duyệt local', state: 'waiting', version: 2, etaAt: new Date(now.getTime() + minutes * 60_000).toISOString() })
    await publishBoard([queued('LIP46_1', 7), queued('LIP47_1', -1)], null, now)
    const keys = ['LIP49_1', 'LIP46_1', 'LIP47_1', 'LIP24_1', 'LIP25_1', 'LIP1_1', 'LIP27_1', 'LIP19_1', 'LIP8_1', 'LIP16_1', 'LIP9999_1', 'LIP12']
    const r = await runAt(`${keys.join(' ')} sửa viền cổ`, fix('FIX', keys, 'sửa viền cổ'), now)
    expect(r.reply).toBe([
      'Đã nhận 1 dòng, Agent làm lần lượt: LIP49_1.',
      'Đang có bên giữ: LIP46_1 (Hàng duyệt local, còn khoảng 7 phút), LIP47_1 (Hàng duyệt local), LIP24_1 (Hoa), LIP25_1 (Auto render), LIP1_1 (Agent).',
      'Không làm: LIP27_1 (đã gửi xưởng), LIP19_1 (đơn đã đóng), LIP8_1 (đang hỏi khách), LIP16_1 (đã huỷ).',
      'Không tìm thấy: LIP9999_1.',
      'Trùng nhiều đơn, gửi lại kèm số dòng: LIP12 (LIP12_1, LIP12_2).',
      'Kết quả xem trên tool.',
    ].join('\n'))
    expect(r.outcome).toBe('JOB'); expect(r.jobIds).toHaveLength(1); expect(lark.reply).toHaveBeenCalledTimes(1)
    expect(await jobsOf('LIP49_1')).toMatchObject([{ kind: 'FIX', source: 'LARK', status: 'QUEUED' }])
    expect(await prisma.designAgentJob.count({ where: { taskKey: { in: ['LIP46_1', 'LIP47_1', 'LIP24_1', 'LIP25_1', 'LIP27_1', 'LIP19_1', 'LIP8_1', 'LIP16_1'] } } })).toBe(0)
    expect((await loadTask('LIP46_1'))!.task.status).toBe('REVIEW')
  })

  it('a list on a stale board or without an instruction makes no job and promises no result', async () => {
    const vague = await run('LIP48_1 LIP9_1 sửa', fix('FIX', ['LIP48_1', 'LIP9_1'], ''))
    expect(vague).toMatchObject({ outcome: 'REPLIED', jobIds: [], reply: 'Không làm: LIP48_1 (cần ghi rõ sửa gì), LIP9_1 (cần ghi rõ sửa gì).' })
    await dropWorkBoard()
    const stale = await run('LIP48_1 LIP23_1 sửa viền', fix('FIX', ['LIP48_1', 'LIP23_1'], 'sửa viền'))
    expect(stale).toMatchObject({ outcome: 'REPLIED', jobIds: [], reply: `Không làm: LIP48_1 (${HOLDER_UNKNOWN}), LIP23_1 (${HOLDER_UNKNOWN}).` })
    expect(await prisma.designAgentJob.count({ where: { taskKey: { in: ['LIP48_1', 'LIP9_1', 'LIP23_1'] } } })).toBe(0)
  })

  it('31 refs handles 30 and says so', async () => {
    const missing = Array.from({ length: 16 }, (_, i) => `LIP${8800 + i}_1`)
    const keys = [...LIST_KEYS, ...missing, 'LIP48_1']
    expect(keys).toHaveLength(31)
    const r = await run(`${keys.join(' ')} sửa viền cổ`, fix('FIX', keys, 'sửa viền cổ'))
    expect(REPLY_LIST_CAP).toBe('Chỉ nhận 30 dòng mỗi tin, gửi phần còn lại ở tin sau.')
    expect(r.reply).toBe([
      `Đã nhận 14 dòng, Agent làm lần lượt: ${LIST_KEYS.join(', ')}.`,
      `Không tìm thấy: ${missing.join(', ')}.`,
      'Kết quả xem trên tool.',
      REPLY_LIST_CAP,
    ].join('\n'))
    expect(lark.reply).toHaveBeenCalledTimes(1)
    expect(await jobsOf('LIP48_1')).toEqual([])
    expect(await prisma.designAgentJob.count({ where: { taskKey: { in: LIST_KEYS } } })).toBe(14)
  })
})

describe('Lark help text and the bot call cap', () => {
  const day = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  const setCount = (key: string, value: number) => prisma.appSetting.upsert({ where: { key }, create: { key, value: String(value) }, update: { value: String(value) } })
  const countOf = async (key: string) => Number((await prisma.appSetting.findUnique({ where: { key } }))?.value ?? 0)

  it('the help texts name the status question and the unassigned report', () => {
    for (const text of [REPLY_OTHER, REPLY_OUT_OF_SCOPE]) {
      expect(text).toContain('LIT6262_1 sao rồi'); expect(text).toContain('việc nào chưa có người làm')
    }
    expect(REPLY_OTHER).toContain('LIT6262_1 sửa sao trên mũ bị lệch')
    expect(REPLY_OUT_OF_SCOPE.startsWith('Bot chỉ nhận việc của Design Studio (sửa mẫu, làm mẫu, mockup).')).toBe(true)
  })

  it('bot cap 300 reached refuses with the existing not-read reply', async () => {
    expect(LARK_DAILY_CALL_CAP).toBe(300)
    const key = `lark.llmCalls.${day()}`
    const before = await countOf(key)
    await setCount(key, 300)
    try {
      const llm = fakeLlm(fix('FIX', ['LIP13_1'], 'sửa viền'))
      const m = await insert(msg('LIP13_1 sửa viền'))
      const r = await processLarkMessage(m, { lark, llm: { llm, model: 'm', cap: LARK_DAILY_CALL_CAP } })
      expect(r).toMatchObject({ outcome: 'ERROR', reply: REPLY_NOT_READ, jobIds: [] })
      expect(llm.complete).not.toHaveBeenCalled()
      expect((await eventOf(m)).error).toBe(new LlmCapReached(300).message)
      expect(await countOf(key)).toBe(300)
      expect(await jobsOf('LIP13_1')).toEqual([])
    } finally {
      await setCount(key, before)
    }
  })

  it('CS cap reached does not stop the bot', async () => {
    const csKey = `cs.llmCalls.${day()}`
    const before = await prisma.appSetting.findUnique({ where: { key: csKey } })
    await setCount(csKey, 500)
    try {
      const r = await run('LIP1_1 là gì', fix('OTHER', ['LIP1_1']))
      expect(r).toMatchObject({ outcome: 'REPLIED', reply: REPLY_OTHER })
      expect(await countOf(csKey)).toBe(500)
    } finally {
      if (before) await setCount(csKey, Number(before.value))
      else await prisma.appSetting.deleteMany({ where: { key: csKey } })
    }
  })
})
