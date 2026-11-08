import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { applyCustomAnswers, customGap, openCustomVerifications, sendShopAppVerifications, sendVerifyEmail, shopAppGap, verifyEmailDraft } from '@/lib/cs/custom-verify'
import { saveCsSettings } from '@/lib/cs/settings'
import { analyzeTicket } from '@/lib/cs/analyze'
import type { Llm } from '@/lib/llm/types'
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

async function makeOrder(line: LineIn, opts: { pipeline?: string; exportedAt?: Date | null; taskStatus?: string; placedAt?: Date; channel?: string; email?: string } = {}) {
  seq++
  const id = `gid://test/Order/cv-${seq}`
  const number = `#CV${1000 + seq}`
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD', grossAmount: 80, expectedPayout: 77, totalFees: 3, refundedAmount: 0,
      placedAt: opts.placedAt ?? new Date('2026-11-06T03:00:00Z'), pipelineStatus: opts.pipeline ?? 'PENDING_DESIGN', orderType: 'CUSTOM', designReady: false,
      exportedAt: opts.exportedAt ?? null, customerEmail: opts.email ?? `buyer${seq}@example.com`, salesChannel: opts.channel ?? 'Online Store', customerName: 'Amy Dufek', shippingName: 'Amy Dufek', shippingCountry: 'US',
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
  await saveCsSettings({ autoVerifyShopApp: true, killSwitch: false, shopAppVerifyFrom: null })
  await prisma.csTicket.deleteMany({})
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

const SHOP_APP = { channel: 'Shop' }
async function shopJacket(opts: Parameters<typeof makeOrder>[1]) {
  await makeOrder({ ...jacket, ...housed('S') }, { pipeline: 'EXPORTED', exportedAt: new Date('2026-11-01T00:00:00Z'), taskStatus: 'DONE' })
  return makeOrder(jacket, opts)
}
const jacket = { title: 'HaPo Legendary Crests 25 Years Of Magic Anniversary Gift - Varsity Jacket-DN1710260259', sku: 'DN1710260259-ADULT', variant: 'Adult / 4XL' }

describe('shopAppGap', () => {
  const line = (title: string, customall: { key: string; value: string }[] | null = null) =>
    ({ sku: 'X-1', productTitle: title, customAttributesJson: JSON.stringify([{ key: '_product_url', value: 'u' }]), customallFieldsJson: customall ? JSON.stringify(customall) : null })
  const sib = (customall: { key: string; value: string }[]) => ({ customAttributesJson: '[]', customallFieldsJson: JSON.stringify(customall) })
  it('a personalised product with nothing on the line asks for the name', () => expect(shopAppGap(line('Personalized Mug'), [])).toEqual({ kind: 'SHOP_APP', fields: ['Custom Name'] }))
  it('asks for the fields other buyers of the product fill in', () => expect(shopAppGap(line('Varsity Jacket'), [sib(housed('A').customall)])?.fields).toEqual(['Choose Your House', 'Custom Name']))
  it('a line that carries its personalisation is complete', () => expect(shopAppGap(line('Personalized Mug', [{ key: 'Custom Name', value: 'Jo' }]), [])).toBeNull())
  it('a product nobody personalises needs nothing', () => expect(shopAppGap(line('Plain Mug'), [{ customAttributesJson: '[]', customallFieldsJson: null }])).toBeNull())
})

describe('Shop app orders', () => {
  it('a Shop app line without personalisation opens a verification and holds design, even in REVIEW', async () => {
    await makeOrder({ ...jacket, ...housed('A') }, { pipeline: 'EXPORTED', exportedAt: new Date('2026-11-01T00:00:00Z'), taskStatus: 'DONE' })
    const o = await makeOrder(jacket, { ...SHOP_APP, taskStatus: 'REVIEW' })
    expect((await openCustomVerifications(NOW)).opened).toBe(1)
    const task = await prisma.csTask.findFirstOrThrow({ where: { designTaskKey: o.taskKey } })
    expect(task.detail).toContain('Shop app')
    const dt = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.taskKey } })
    expect([dt.status, dt.prevStatus]).toEqual(['ASK_CUSTOMER', 'REVIEW'])
  })
  it('only Shop app orders placed from the start date (Vietnam day) are verified', async () => {
    await saveCsSettings({ shopAppVerifyFrom: '2026-11-08' })
    const before = await shopJacket({ ...SHOP_APP, placedAt: new Date('2026-11-07T16:59:00Z') })
    const after = await makeOrder(jacket, { ...SHOP_APP, placedAt: new Date('2026-11-07T17:00:00Z') })
    expect((await openCustomVerifications(NOW)).opened).toBe(1)
    expect(await prisma.csTask.count({ where: { designTaskKey: after.taskKey } })).toBe(1)
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: before.taskKey } })).status).toBe('NEW')
  })
  it('a Shop app line that has its personalisation is left alone', async () => {
    await makeOrder({ ...jacket, ...housed('Amy') }, SHOP_APP)
    expect((await openCustomVerifications(NOW)).opened).toBe(0)
  })
})

describe('sendShopAppVerifications', () => {
  const fakeFd = () => { const sent: any[] = []; return { sent, fd: { async outboundEmail(p: any) { sent.push(p); return { id: 900 + sent.length } } } } }
  it('emails each customer once for all their Shop app lines and moves the tasks to Chờ phản hồi', async () => {
    const a = await shopJacket({ ...SHOP_APP, email: 'amy@example.com' })
    const b = await makeOrder({ title: 'HaPo Moonlit Hogwarts Express Zip Hoodie - Personalized AOP-DN1210261516', sku: 'DN1210261516-ZIP', variant: 'Zip Hoodie / 4XL' }, { ...SHOP_APP, email: 'amy@example.com' })
    await openCustomVerifications(NOW)
    const { sent, fd } = fakeFd()
    expect((await sendShopAppVerifications({ fd, emailConfigId: 1 }, NOW)).emailed).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].email).toBe('amy@example.com')
    expect(sent[0].subject).toContain(a.number)
    expect(sent[0].subject).toContain(b.number)
    expect(sent[0].description).toContain('Shop app')
    expect(sent[0].description).toContain('no extra charge')
    expect(sent[0].tags).toContain('em-verify-custom')
    const tasks = await prisma.csTask.findMany({ include: { events: true } })
    expect(tasks.map(t => t.status)).toEqual(['WAITING', 'WAITING'])
    expect(tasks.every(t => t.events.some(e => e.body.includes('#901')))).toBe(true)
    expect((await sendShopAppVerifications({ fd, emailConfigId: 1 }, NOW)).emailed).toBe(0)
    expect(sent).toHaveLength(1)
  })
  it('does not email a customer who already has an open ticket about the order, and says so once', async () => {
    const o = await shopJacket({ ...SHOP_APP, email: 'amy@example.com' })
    await prisma.csTicket.create({ data: { fdTicketId: 8801, subject: 'Where is my jacket', fdStatus: 2, fdPriority: 1, orderNumber: o.number, fdCreatedAt: NOW, fdUpdatedAt: NOW } })
    await openCustomVerifications(NOW)
    const { sent, fd } = fakeFd()
    await sendShopAppVerifications({ fd, emailConfigId: 1 }, NOW)
    await sendShopAppVerifications({ fd, emailConfigId: 1 }, NOW)
    expect(sent).toHaveLength(0)
    const task = await prisma.csTask.findFirstOrThrow({ include: { events: true } })
    expect(task.status).toBe('NEW')
    expect(task.events.filter(e => e.body.includes('#8801'))).toHaveLength(1)
  })
  it('never emails a web order by itself, and stays quiet when switched off', async () => {
    await makeOrder({ attrs: [{ key: '_Custom Name:', value: 'Yes' }] })
    await shopJacket(SHOP_APP)
    await openCustomVerifications(NOW)
    const { sent, fd } = fakeFd()
    await saveCsSettings({ autoVerifyShopApp: false })
    expect((await sendShopAppVerifications({ fd, emailConfigId: 1 }, NOW)).emailed).toBe(0)
    await saveCsSettings({ autoVerifyShopApp: true })
    await sendShopAppVerifications({ fd, emailConfigId: 1 }, NOW)
    expect(sent).toHaveLength(1)
    expect(await prisma.csTask.count({ where: { status: 'NEW' } })).toBe(1)
  })
})

describe('applyCustomAnswers', () => {
  async function waiting(email = 'amy@example.com') {
    const o = await shopJacket({ ...SHOP_APP, email })
    await openCustomVerifications(NOW)
    await prisma.csTask.updateMany({ where: { designTaskKey: o.taskKey }, data: { status: 'WAITING' } })
    return o
  }
  it('a clear answer closes the task, writes it for the designer and lets design continue', async () => {
    const o = await waiting()
    expect(await applyCustomAnswers([{ orderNumber: o.number, answer: 'House: Ravenclaw; Name: Amy', clear: true }], NOW)).toBe(1)
    const task = await prisma.csTask.findFirstOrThrow({ where: { designTaskKey: o.taskKey }, include: { events: true } })
    expect(task.status).toBe('DONE')
    expect(task.events.some(e => e.authorName === 'Agent' && e.body.includes('Ravenclaw'))).toBe(true)
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: o.id } })).designNote).toContain('House: Ravenclaw; Name: Amy')
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.taskKey } })).status).toBe('NEW')
  })
  it('an unclear answer stays with CS, noted once', async () => {
    const o = await waiting()
    const ans = [{ orderNumber: o.number, answer: 'Can I change the size too?', clear: false }]
    expect(await applyCustomAnswers(ans, NOW)).toBe(0)
    await applyCustomAnswers(ans, NOW)
    const task = await prisma.csTask.findFirstOrThrow({ where: { designTaskKey: o.taskKey }, include: { events: true } })
    expect(task.status).toBe('WAITING')
    expect(task.events.filter(e => e.body.includes('Can I change the size too?'))).toHaveLength(1)
  })
  it('an order with two open verifications goes to CS instead of guessing which line the answer is for', async () => {
    const o = await waiting()
    await prisma.csTask.create({ data: { orderNumber: o.number, type: 'VERIFY_CUSTOM', dept: 'CS', priority: 1, status: 'WAITING', detail: 'second line' } })
    expect(await applyCustomAnswers([{ orderNumber: o.number, answer: 'Name: Amy', clear: true }], NOW)).toBe(0)
    expect(await prisma.csTask.count({ where: { status: 'DONE' } })).toBe(0)
  })
  it('the analysis of a reply applies the answers the model read', async () => {
    const o = await waiting()
    const t = await prisma.csTicket.create({ data: { fdTicketId: 8802, subject: 'Re: A quick question', fdStatus: 2, fdPriority: 1, orderNumber: o.number, fdCreatedAt: NOW, fdUpdatedAt: NOW, lastCustomerAt: NOW } })
    await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: 'cv-1', author: 'CUSTOMER', bodyText: 'Ravenclaw please, name Amy', createdAt: NOW } })
    const llm = {
      async complete(): Promise<any> { throw new Error('not used') },
      async analyze() {
        return { output: { category: 'PERSONALIZATION_ISSUE', urgency: 'NORMAL', sentiment: 'CALM', orderNumber: o.number, summary: 's', facts: [], proposal: 'p', citedCaseIds: [], draftReply: null, needsHuman: true, needsHumanReason: 'r', autoReplyEligible: false, autoReplyReason: 'r', humanRequested: false, tasks: [], customAnswers: [{ orderNumber: o.number, answer: 'House: Ravenclaw; Name: Amy', clear: true }] }, tokensIn: 1, tokensOut: 1 }
      },
    } as unknown as Llm
    await analyzeTicket(t.id, { llm, now: NOW, force: true })
    expect((await prisma.csTask.findFirstOrThrow({ where: { designTaskKey: o.taskKey } })).status).toBe('DONE')
  })
})
