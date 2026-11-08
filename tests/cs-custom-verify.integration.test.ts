import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { customGap, openCustomVerifications, sendVerifyEmail, verifyEmailDraft } from '@/lib/cs/custom-verify'
import { updateTask } from '@/lib/cs/tasks'
import { runAgentCycle } from '@/lib/cs/agent'
import { NextRequest } from 'next/server'
import { signToken, AUTH_COOKIE } from '@/lib/auth'
import { GET as draftRoute, POST as sendRoute } from '@/app/api/cs/tasks/[id]/verify-email/route'

const PROJECT = 'proj_cv'
const SHOP = 'cv-test.myshopify.com'
const NOW = new Date('2026-11-08T03:00:00Z')
const staff = { id: 'u-cs', name: 'Trang' }
let storeId = ''
let seq = 0

type LineIn = { sku?: string; title?: string; variant?: string; attrs?: { key: string; value: string }[]; customall?: { key: string; value: string }[] | null }

async function makeOrder(line: LineIn, opts: { pipeline?: string; exportedAt?: Date | null; taskStatus?: string; placedAt?: Date } = {}) {
  seq++
  const id = `gid://test/Order/cv-${seq}`
  const number = `#CV${1000 + seq}`
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD', grossAmount: 80, expectedPayout: 77, totalFees: 3, refundedAmount: 0,
      placedAt: opts.placedAt ?? new Date('2026-11-06T03:00:00Z'), pipelineStatus: opts.pipeline ?? 'PENDING_DESIGN', orderType: 'CUSTOM', designReady: false,
      exportedAt: opts.exportedAt ?? null, customerEmail: `buyer${seq}@example.com`, customerName: 'Amy Dufek', shippingName: 'Amy Dufek', shippingCountry: 'US',
      lines: { create: [{
        shopifyLineId: `cvl-${seq}`, productTitle: line.title ?? 'HaPo Legendary Crests Varsity Jacket-DN1710260259', variantTitle: line.variant ?? 'Adult / 4XL', qty: 1, linePosition: 1, unitPrice: 66.99,
        sku: line.sku ?? 'DN1710260259-ADULT', customized: false,
        customAttributesJson: JSON.stringify([...(line.attrs ?? []), { key: '_product_url', value: 'https://litzzy.com/products/x' }]),
        customallFieldsJson: line.customall ? JSON.stringify(line.customall) : null,
      }] },
      designTasks: { create: [{ shopifyLineId: `cvl-${seq}`, taskKey: `CV${1000 + seq}_1`, status: opts.taskStatus ?? 'NEW' }] },
    },
  })
  return { id, number, taskKey: `CV${1000 + seq}_1` }
}

const housed = (name: string) => ({ customall: [{ key: 'Choose Your House', value: 'download - 2026-10-21' }, { key: 'Custom Name Yes or No', value: 'Yes' }, { key: 'Custom Name', value: name }] })

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CV', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
})
beforeEach(async () => {
  await prisma.csTask.deleteMany({})
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
})
afterAll(async () => {
  await prisma.csTask.deleteMany({})
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
})

describe('customGap', () => {
  const line = (attrs: { key: string; value: string }[], customall: { key: string; value: string }[] | null = null) =>
    ({ sku: 'X-1', productTitle: 'p', customAttributesJson: JSON.stringify(attrs), customallFieldsJson: customall ? JSON.stringify(customall) : null })
  it('a name switched on with no name is a NAME_MISSING gap', () => {
    expect(customGap(line([{ key: '_Custom Name:', value: 'Yes' }]), [])).toMatchObject({ kind: 'NAME_MISSING' })
    expect(customGap(line([{ key: 'Custom Name: Yes Or No?', value: 'Yes' }]), [])).toMatchObject({ kind: 'NAME_MISSING' })
  })
  it('a name typed anywhere closes the gap', () => {
    expect(customGap(line([{ key: 'Custom Name: Yes Or No?', value: 'Yes' }, { key: 'Enter Your Personalization', value: 'Deborah' }]), [])).toBeNull()
    expect(customGap(line([{ key: '_Custom Name:', value: 'Yes' }, { key: 'Custom Name', value: 'Pedro' }]), [])).toBeNull()
    expect(customGap(line([], [{ key: 'Custom Name Yes or No', value: 'Yes' }, { key: 'Custom Name', value: 'Ann Marie' }]), [])).toBeNull()
  })
  it('a name switched off is not a gap', () => expect(customGap(line([{ key: 'Custom Name: Yes Or No?', value: 'No' }]), [])).toBeNull())
  it('an empty line of a product others personalise is a CUSTOM_MISSING gap that names the usual fields', () => {
    const siblings = [housed('A').customall, housed('B').customall, housed('C').customall].map(c => line([], c))
    const gap = customGap(line([]), siblings)
    expect(gap?.kind).toBe('CUSTOM_MISSING')
    expect(gap?.fields).toEqual(['Choose Your House', 'Custom Name'])
  })
  it('an empty line of a product nobody personalises is fine', () => expect(customGap(line([]), [line([]), line([]), line([])])).toBeNull())
})

describe('openCustomVerifications', () => {
  it('opens a Xác minh custom task and puts the design task on hold (Đang hỏi khách)', async () => {
    const o = await makeOrder({ title: 'Multicolor Jeep Girl Sherpa Hoodie TN2605261712', sku: 'TN2605261712-Turquoise', variant: 'Turquoise / S / Unisex', attrs: [{ key: '_Custom Name:', value: 'Yes' }] })
    const r = await openCustomVerifications(NOW)
    expect(r.opened).toBe(1)
    const [task] = await prisma.csTask.findMany()
    expect(task).toMatchObject({ type: 'VERIFY_CUSTOM', orderNumber: o.number, designTaskKey: o.taskKey, dept: 'CS', priority: 1, status: 'NEW' })
    expect(task.detail).toContain('tên')
    const dt = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.taskKey }, include: { events: true } })
    expect(dt.status).toBe('ASK_CUSTOMER')
    expect(dt.prevStatus).toBe('NEW')
    expect(dt.events.find(e => e.type === 'ASK')?.message).toContain('Hỏi khách')
    expect((await openCustomVerifications(NOW)).opened).toBe(0)
    expect(await prisma.csTask.count()).toBe(1)
  })
  it('does not guess a Shop app order from its siblings: optional names leave lines empty too, so it waits for a channel flag', async () => {
    for (const n of ['A', 'B', 'C']) await makeOrder(housed(n), { pipeline: 'EXPORTED', exportedAt: new Date('2026-11-01T00:00:00Z'), taskStatus: 'DONE' })
    const o = await makeOrder({})
    expect((await openCustomVerifications(NOW)).opened).toBe(0)
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.taskKey } })).status).toBe('NEW')
  })
  it('leaves orders already sent to the factory alone', async () => {
    await makeOrder({ attrs: [{ key: '_Custom Name:', value: 'Yes' }] }, { pipeline: 'EXPORTED', exportedAt: new Date('2026-11-07T00:00:00Z') })
    expect((await openCustomVerifications(NOW)).opened).toBe(0)
  })
  it('does not duplicate a personalisation task staff already opened for the order', async () => {
    const o = await makeOrder({ attrs: [{ key: '_Custom Name:', value: 'Yes' }] })
    await prisma.csTask.create({ data: { orderNumber: o.number, type: 'PERSONALIZATION_CHANGE', dept: 'DESIGN', priority: 1, detail: 'đã hỏi khách' } })
    expect((await openCustomVerifications(NOW)).opened).toBe(0)
  })
  it('a designer pressing Hỏi khách puts a task on the CS board with the question', async () => {
    const o = await makeOrder({ attrs: [{ key: 'Custom Name', value: 'Jaye' }] }, { taskStatus: 'ASK_CUSTOMER' })
    const dt = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.taskKey } })
    await prisma.designTaskEvent.create({ data: { taskId: dt.id, type: 'ASK', message: 'Hỏi khách: tên dài quá, khách muốn bỏ chữ nào?' } })
    expect((await openCustomVerifications(NOW)).opened).toBe(1)
    const task = await prisma.csTask.findFirstOrThrow({ where: { designTaskKey: o.taskKey } })
    expect(task.detail).toContain('tên dài quá')
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.taskKey } })).status).toBe('ASK_CUSTOMER')
  })
})

describe('/api/cs/tasks/[id]/verify-email', () => {
  it('GET returns the draft; POST refuses to send without a Freshdesk key', async () => {
    process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
    const u = await prisma.appUser.upsert({ where: { email: 'cv-route@test.local' }, update: {}, create: { name: 'Trang', email: 'cv-route@test.local', role: 'SUPPORT', permissions: JSON.stringify(['cs']) } })
    const token = await signToken({ userId: u.id, email: u.email, name: u.name, role: 'SUPPORT', permissions: ['cs'], tv: 0 })
    const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/cs/tasks/x/verify-email', { method, headers: { 'content-type': 'application/json', cookie: `${AUTH_COOKIE}=${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    await makeOrder({ attrs: [{ key: '_Custom Name:', value: 'Yes' }] })
    await openCustomVerifications(NOW)
    const task = await prisma.csTask.findFirstOrThrow()
    const got = await draftRoute(req('GET'), { params: { id: task.id } })
    expect(got.status).toBe(200)
    expect((await got.json()).body).toContain("name itself didn't come through")
    const sent = await sendRoute(req('POST', { subject: 'Q', body: 'Hi' }), { params: { id: task.id } })
    expect(sent.status).toBe(400)
    expect((await prisma.csTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('NEW')
    await prisma.appUser.delete({ where: { id: u.id } })
  })
  it('404 for a task that does not exist', async () => {
    const res = await draftRoute(new NextRequest('http://localhost/x'), { params: { id: 'nope' } })
    expect(res.status).toBe(404)
  })
})

describe('agent cycle', () => {
  it('opens verifications on every run, even without a model', async () => {
    const o = await makeOrder({ attrs: [{ key: '_Custom Name:', value: 'Yes' }] })
    const fd: any = { requests: 0, async listTickets() { return [] }, async getConversations() { return [] }, async reply() { return { id: 1 } }, async note() { return { id: 1 } }, async update() {} }
    await runAgentCycle({ fd, llm: null, notifier: async () => {}, appUrl: 'http://app.test', now: NOW } as any)
    expect(await prisma.csTask.count({ where: { designTaskKey: o.taskKey, type: 'VERIFY_CUSTOM' } })).toBe(1)
  })
})

describe('closing a verification', () => {
  it('needs the customer answer, writes it for the designer and lets the design task continue', async () => {
    const o = await makeOrder({ attrs: [{ key: '_Custom Name:', value: 'Yes' }] })
    await openCustomVerifications(NOW)
    const task = await prisma.csTask.findFirstOrThrow({ where: { type: 'VERIFY_CUSTOM' } })
    await expect(updateTask(task.id, { status: 'DONE' }, staff)).rejects.toThrow(/câu trả lời/)
    await updateTask(task.id, { status: 'DONE', note: 'Tên: Patrick' }, staff, new Date('2026-11-08T05:00:00Z'))
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })
    expect(line.designNote).toContain('Tên: Patrick')
    const dt = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.taskKey }, include: { events: { orderBy: { createdAt: 'asc' } } } })
    expect(dt.status).toBe('NEW')
    expect(dt.prevStatus).toBeNull()
    expect(dt.events.at(-1)?.message).toContain('Tên: Patrick')
  })
})

describe('verification email', () => {
  it('drafts a name question for a NAME_MISSING line', async () => {
    await makeOrder({ title: 'Multicolor Jeep Girl Sherpa Hoodie TN2605261712', variant: 'Turquoise / S / Unisex', attrs: [{ key: '_Custom Name:', value: 'Yes' }] })
    await openCustomVerifications(NOW)
    const task = await prisma.csTask.findFirstOrThrow()
    const d = await verifyEmailDraft(task.id)
    expect(d.to).toMatch(/@example\.com$/)
    expect(d.subject).toContain(task.orderNumber!)
    expect(d.body).toContain('Hi Amy')
    expect(d.body).toContain('Multicolor Jeep Girl Sherpa Hoodie')
    expect(d.body).toContain("name itself didn't come through")
    expect(d.body).toContain('Warm regards,\nLitzzy Support')
  })
  it('sends it from Freshdesk, moves the task to Chờ phản hồi and logs the ticket', async () => {
    await makeOrder({ attrs: [{ key: '_Custom Name:', value: 'Yes' }] })
    await openCustomVerifications(NOW)
    const task = await prisma.csTask.findFirstOrThrow()
    const sent: any[] = []
    const fd = { async outboundEmail(p: any) { sent.push(p); return { id: 777 } } }
    const r = await sendVerifyEmail(task.id, { subject: 'Q', body: 'Hi Amy,\n\nWhat name?' }, staff, { fd, emailConfigId: 158000294295 }, new Date('2026-11-08T04:00:00Z'))
    expect(r.fdTicketId).toBe(777)
    expect(sent[0]).toMatchObject({ subject: 'Q', email_config_id: 158000294295, custom_fields: { cf_order_id: task.orderNumber } })
    expect(sent[0].description).toContain('<p>What name?</p>')
    const after = await prisma.csTask.findUniqueOrThrow({ where: { id: task.id }, include: { events: true } })
    expect(after.status).toBe('WAITING')
    expect(after.events.some(e => e.body.includes('#777'))).toBe(true)
  })
})
