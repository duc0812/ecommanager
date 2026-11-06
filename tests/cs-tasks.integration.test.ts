import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import type { Llm } from '@/lib/llm/types'
import { analyzeTicket } from '@/lib/cs/analyze'
import { saveCsSettings } from '@/lib/cs/settings'
import { addTaskComment, applyAgentTasks, createTask, listTasks, markRead, needsRead, taskDetail, updateTask, TASK_META } from '@/lib/cs/tasks'

const T = (iso: string) => new Date(iso)
const staff = { id: 'u-staff', name: 'Trang' }

async function mk(fdId: number, patch: Record<string, unknown> = {}) {
  const t = await prisma.csTicket.create({ data: { fdTicketId: fdId, subject: `task ${fdId}`, fdStatus: 2, fdPriority: 1, orderNumber: '#LIT9001', fdCreatedAt: T('2026-11-05T08:00:00Z'), fdUpdatedAt: T('2026-11-05T08:00:00Z'), lastCustomerAt: T('2026-11-05T08:00:00Z'), ...patch } })
  await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: `task-${fdId}`, author: 'CUSTOMER', bodyText: 'Please send it to 12 New St instead', createdAt: T('2026-11-05T08:00:00Z') } })
  return t
}

beforeAll(async () => { await saveCsSettings({ llmDailyCallCap: 500 }) })
beforeEach(async () => { await prisma.csTask.deleteMany({}); await prisma.csTicket.deleteMany({}); await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'cs.llmCalls.' } } }) })
afterAll(async () => { await prisma.csTask.deleteMany({}); await prisma.csTicket.deleteMany({}) })

describe('needsRead', () => {
  const base = { fdStatus: 2, lastCustomerAt: T('2026-11-05T08:00:00Z'), lastAgentAt: null as Date | null, staffReadAt: null as Date | null }
  it('an open ticket nobody has read needs reading', () => expect(needsRead(base)).toBe(true))
  it('reading it clears the flag', () => expect(needsRead({ ...base, staffReadAt: T('2026-11-05T09:00:00Z') })).toBe(false))
  it('a new customer message after the read makes it unread again', () => expect(needsRead({ ...base, staffReadAt: T('2026-11-05T09:00:00Z'), lastCustomerAt: T('2026-11-05T10:00:00Z') })).toBe(true))
  it('an agent reply after the read makes it unread again', () => expect(needsRead({ ...base, staffReadAt: T('2026-11-05T09:00:00Z'), lastAgentAt: T('2026-11-05T09:30:00Z') })).toBe(true))
  it('resolved and closed tickets never need reading', () => {
    expect(needsRead({ ...base, fdStatus: 4 })).toBe(false)
    expect(needsRead({ ...base, fdStatus: 5 })).toBe(false)
  })
  it('a ticket with no customer or agent activity needs nothing', () => expect(needsRead({ ...base, lastCustomerAt: null })).toBe(false))
})

describe('markRead', () => {
  it('stores who read the ticket and when', async () => {
    const t = await mk(7001)
    await markRead(t.id, staff, T('2026-11-05T09:00:00Z'))
    const after = await prisma.csTicket.findUniqueOrThrow({ where: { id: t.id } })
    expect(after.staffReadById).toBe('u-staff')
    expect(after.staffReadByName).toBe('Trang')
    expect(after.staffReadAt).toEqual(T('2026-11-05T09:00:00Z'))
    expect(needsRead(after)).toBe(false)
  })
})

describe('applyAgentTasks', () => {
  it('opens a third-party task with its department, top priority, a 24-hour due time and a CREATED event', async () => {
    const t = await mk(7002)
    const created = await applyAgentTasks(t, [{ type: 'ADDRESS_CHANGE', detail: 'Đổi địa chỉ sang 12 New St' }], T('2026-11-05T08:05:00Z'))
    expect(created).toBe(1)
    const [task] = await prisma.csTask.findMany({ include: { events: true } })
    expect(task).toMatchObject({ ticketId: t.id, orderNumber: '#LIT9001', type: 'ADDRESS_CHANGE', dept: 'FULFILLMENT', priority: 1, status: 'NEW', source: 'AGENT', detail: 'Đổi địa chỉ sang 12 New St' })
    expect(task.dueAt).toEqual(T('2026-11-06T08:05:00Z'))
    expect(task.events.map(e => [e.kind, e.authorName])).toEqual([['CREATED', 'Agent']])
  })
  it('refunds rank below third-party work and go to CS', () => {
    expect(TASK_META.REFUND).toMatchObject({ dept: 'CS', priority: 2 })
    expect(TASK_META.SIZE_CHANGE).toMatchObject({ dept: 'FULFILLMENT', priority: 1 })
    expect(TASK_META.PERSONALIZATION_CHANGE).toMatchObject({ dept: 'DESIGN', priority: 1 })
  })
  it('does not open a second task of the same type while one is open; a changed detail is logged on the open one', async () => {
    const t = await mk(7003)
    await applyAgentTasks(t, [{ type: 'ADDRESS_CHANGE', detail: 'Đổi địa chỉ sang 12 New St' }], T('2026-11-05T08:05:00Z'))
    expect(await applyAgentTasks(t, [{ type: 'ADDRESS_CHANGE', detail: 'Đổi địa chỉ sang 12 New St' }], T('2026-11-05T09:00:00Z'))).toBe(0)
    expect(await prisma.csTaskEvent.count()).toBe(1)
    expect(await applyAgentTasks(t, [{ type: 'ADDRESS_CHANGE', detail: 'Đổi địa chỉ sang 14 Other Ave' }], T('2026-11-05T10:00:00Z'))).toBe(0)
    const tasks = await prisma.csTask.findMany({ include: { events: { orderBy: { createdAt: 'asc' } } } })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].detail).toBe('Đổi địa chỉ sang 14 Other Ave')
    expect(tasks[0].events.map(e => e.kind)).toEqual(['CREATED', 'AGENT'])
  })
  it('opens a new task once the earlier one of that type is done', async () => {
    const t = await mk(7004)
    await applyAgentTasks(t, [{ type: 'SIZE_CHANGE', detail: 'Đổi size L → XL' }], T('2026-11-05T08:05:00Z'))
    const first = await prisma.csTask.findFirstOrThrow()
    await updateTask(first.id, { status: 'DONE' }, staff, T('2026-11-05T12:00:00Z'))
    expect(await applyAgentTasks(t, [{ type: 'SIZE_CHANGE', detail: 'Đổi size XL → 2XL' }], T('2026-11-06T08:00:00Z'))).toBe(1)
    expect(await prisma.csTask.count()).toBe(2)
  })
  it('ignores a type it does not know', async () => {
    const t = await mk(7005)
    expect(await applyAgentTasks(t, [{ type: 'MAKE_COFFEE' as any, detail: 'x' }], T('2026-11-05T08:05:00Z'))).toBe(0)
  })
})

describe('updateTask / comments', () => {
  it('a status change is logged with who moved it, from what, to what and why; DONE stamps doneAt', async () => {
    const t = await mk(7006)
    await applyAgentTasks(t, [{ type: 'CANCEL_ORDER', detail: 'Huỷ đơn theo yêu cầu' }], T('2026-11-05T08:05:00Z'))
    const task = await prisma.csTask.findFirstOrThrow()
    await updateTask(task.id, { status: 'IN_PROGRESS', note: 'Đã báo xưởng Mango dừng sản xuất' }, staff, T('2026-11-05T09:00:00Z'))
    await updateTask(task.id, { status: 'DONE', note: 'Xưởng xác nhận đã huỷ' }, staff, T('2026-11-05T11:00:00Z'))
    const d = await taskDetail(task.id)
    expect(d!.task.status).toBe('DONE')
    expect(d!.task.doneAt).toEqual(T('2026-11-05T11:00:00Z'))
    const moves = d!.events.filter(e => e.kind === 'STATUS').map(e => [e.fromStatus, e.toStatus, e.body, e.authorName])
    expect(moves).toEqual([['NEW', 'IN_PROGRESS', 'Đã báo xưởng Mango dừng sản xuất', 'Trang'], ['IN_PROGRESS', 'DONE', 'Xưởng xác nhận đã huỷ', 'Trang']])
  })
  it('rejects an unknown status', async () => {
    const t = await mk(7007)
    await applyAgentTasks(t, [{ type: 'OTHER', detail: 'x' }], T('2026-11-05T08:05:00Z'))
    const task = await prisma.csTask.findFirstOrThrow()
    await expect(updateTask(task.id, { status: 'LOST' as any }, staff)).rejects.toThrow()
  })
  it('a refund cannot be closed until the agreed amount is written down, and the amount change is logged', async () => {
    const t = await mk(7013)
    const task = await createTask({ ticketId: t.id, type: 'REFUND', detail: 'Khách đồng ý hoàn tiền' }, staff, T('2026-11-05T08:05:00Z'))
    expect(task.amount).toBeNull()
    await expect(updateTask(task.id, { status: 'DONE' }, staff)).rejects.toThrow(/số tiền/)
    await updateTask(task.id, { amount: 30.41 }, staff, T('2026-11-05T09:00:00Z'))
    const done = await updateTask(task.id, { status: 'DONE', note: 'Đã refund trên Shopify' }, staff, T('2026-11-05T10:00:00Z'))
    expect(done.amount).toBe(30.41)
    expect(done.status).toBe('DONE')
    const d = await taskDetail(task.id)
    expect(d!.events.find(e => e.kind === 'AMOUNT')?.body).toBe('$30.41')
  })
  it('the agent can carry the agreed amount on a refund task', async () => {
    const t = await mk(7014)
    await applyAgentTasks(t, [{ type: 'REFUND', detail: 'Khách đồng ý refund 50%', amount: 15.5 }], T('2026-11-05T08:05:00Z'))
    expect((await prisma.csTask.findFirstOrThrow()).amount).toBe(15.5)
  })
  it('rejects a negative amount', async () => {
    const t = await mk(7015)
    const task = await createTask({ ticketId: t.id, type: 'REFUND', detail: 'x' }, staff)
    await expect(updateTask(task.id, { amount: -1 }, staff)).rejects.toThrow()
  })
  it('a comment joins the thread', async () => {
    const t = await mk(7008)
    await applyAgentTasks(t, [{ type: 'PERSONALIZATION_CHANGE', detail: 'Tên mới: Jaye' }], T('2026-11-05T08:05:00Z'))
    const task = await prisma.csTask.findFirstOrThrow()
    await addTaskComment(task.id, 'Design đã sửa file in', staff, T('2026-11-05T09:00:00Z'))
    const d = await taskDetail(task.id)
    expect(d!.events.at(-1)).toMatchObject({ kind: 'COMMENT', body: 'Design đã sửa file in', authorName: 'Trang' })
  })
  it('staff can open a task by hand from a ticket', async () => {
    const t = await mk(7009)
    const task = await createTask({ ticketId: t.id, type: 'REFUND', detail: 'Khách đồng ý refund 100% $30.41' }, staff, T('2026-11-05T08:05:00Z'))
    expect(task).toMatchObject({ source: 'STAFF', createdByName: 'Trang', dept: 'CS', priority: 2, orderNumber: '#LIT9001' })
  })
})

describe('listTasks', () => {
  it('lists third-party work first, then refunds, oldest first within a priority, filtered by department', async () => {
    const a = await mk(7010)
    const b = await mk(7011)
    await applyAgentTasks(a, [{ type: 'REFUND', detail: 'refund' }], T('2026-11-05T07:00:00Z'))
    await applyAgentTasks(b, [{ type: 'SIZE_CHANGE', detail: 'size' }], T('2026-11-05T08:00:00Z'))
    await applyAgentTasks(a, [{ type: 'ADDRESS_CHANGE', detail: 'addr' }], T('2026-11-05T09:00:00Z'))
    expect((await listTasks({})).map(t => t.type)).toEqual(['SIZE_CHANGE', 'ADDRESS_CHANGE', 'REFUND'])
    expect((await listTasks({ dept: 'CS' })).map(t => t.type)).toEqual(['REFUND'])
    expect((await listTasks({}))[0].ticket?.fdTicketId).toBe(7011)
  })
})

describe('agent opens tasks while analysing', () => {
  it('the tasks in the model output land on the board', async () => {
    const t = await mk(7012)
    const llm = {
      async complete(): Promise<any> { throw new Error('not used') },
      async analyze() {
        return { output: { category: 'ADDRESS_CHANGE', urgency: 'URGENT', sentiment: 'CALM', orderNumber: '#LIT9001', summary: 's', facts: [], proposal: 'p', citedCaseIds: [], draftReply: null, needsHuman: true, needsHumanReason: 'r', autoReplyEligible: false, autoReplyReason: 'r', humanRequested: false, tasks: [{ type: 'ADDRESS_CHANGE', detail: 'Đổi địa chỉ sang 12 New St' }] }, tokensIn: 1, tokensOut: 1 }
      },
    } as unknown as Llm
    await analyzeTicket(t.id, { llm, now: T('2026-11-05T08:05:00Z'), force: true })
    const tasks = await prisma.csTask.findMany()
    expect(tasks.map(x => [x.type, x.ticketId])).toEqual([['ADDRESS_CHANGE', t.id]])
  })
})
