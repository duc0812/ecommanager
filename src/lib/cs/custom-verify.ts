import { prisma } from '@/lib/db'
import type { CsTask } from '@/generated/prisma/client'
import { OPEN_STATUSES, TASK_META } from '@/lib/cs/task-labels'
import { getCsSettings } from '@/lib/cs/settings'

type Field = { key: string; value: string }
type LineData = { sku: string | null; productTitle: string; customAttributesJson: string | null; customallFieldsJson: string | null }
export type CustomGap = { kind: 'NAME_MISSING' | 'CUSTOM_MISSING' | 'SHOP_APP'; fields: string[] }
type Actor = { id: string; name: string }

const WINDOW_DAYS = 21
const ASK_WINDOW_DAYS = 45
const SIBLINGS = 10
const MIN_PERSONALISED_SIBLINGS = 3
const DUE_HOURS = 24
// Design tasks a verification can put on hold; REVIEW is caught too but left alone, its art is already waiting for approval.
const HOLDABLE = ['NEW', 'ASSIGNED', 'DOING', 'REJECTED']
const CATCHABLE = [...HOLDABLE, 'REVIEW']
const SHIPPED_PIPELINE = ['EXPORTED', 'FULFILLED', 'CANCELLED']
const AGENT = { id: 'agent', name: 'Agent' }
const BLOCKING_TYPES = ['PERSONALIZATION_CHANGE', 'VERIFY_CUSTOM']

function parse(json: string | null | undefined): Field[] {
  try {
    const v = JSON.parse(json || '[]')
    return Array.isArray(v) ? v.filter(f => f && typeof f.key === 'string').map(f => ({ key: f.key, value: String(f.value ?? '') })) : []
  } catch { return [] }
}

const isYesNo = (v: string) => ['yes', 'no'].includes(v.trim().toLowerCase())
const isNameSwitch = (f: Field) => /custom name/i.test(f.key) && f.value.trim().toLowerCase() === 'yes'
const isTypedText = (f: Field) => /name|text|personali|initial/i.test(f.key) && f.value.trim() !== '' && !isYesNo(f.value) && !/^https?:\/\//.test(f.value.trim())
const visible = (fields: Field[]) => fields.filter(f => !f.key.startsWith('_'))
const cleanKey = (k: string) => k.replace(/^(copy of\s+)+/i, '').trim()

function personalised(line: Pick<LineData, 'customAttributesJson' | 'customallFieldsJson'>): boolean {
  const attrs = parse(line.customAttributesJson)
  return parse(line.customallFieldsJson).length > 0 || visible(attrs).length > 0 || attrs.some(a => a.key === '_customall_preview' || a.key === '_pers')
}

// What a line is missing before it can be printed: a name the customer paid for but never typed, or the whole
// personalisation of a product its other buyers always personalise (the Shop app drops it).
export function customGap(line: LineData, siblings: Pick<LineData, 'customAttributesJson' | 'customallFieldsJson'>[]): CustomGap | null {
  const fields = [...parse(line.customAttributesJson), ...parse(line.customallFieldsJson)]
  if (fields.some(isNameSwitch) && !fields.some(isTypedText)) return { kind: 'NAME_MISSING', fields: ['Custom Name'] }
  if (personalised(line)) return null
  const done = siblings.filter(personalised)
  if (done.length < MIN_PERSONALISED_SIBLINGS) return null
  return { kind: 'CUSTOM_MISSING', fields: siblingFields(done) }
}

// The personalisation fields buyers of the product fill in, without the Yes/No switches.
function siblingFields(done: Pick<LineData, 'customAttributesJson' | 'customallFieldsJson'>[]): string[] {
  const seen = new Map<string, string[]>()
  for (const s of done) {
    for (const f of [...parse(s.customallFieldsJson), ...visible(parse(s.customAttributesJson))]) {
      const key = cleanKey(f.key)
      seen.set(key, [...(seen.get(key) ?? []), f.value])
    }
  }
  return Array.from(seen).filter(([, values]) => !values.every(isYesNo)).map(([key]) => key)
}

export const isShopApp = (channel: string | null | undefined) => channel === 'Shop' || channel === '3890849'

// The Shop app never shows the product page's personalisation form, so a Shop app line of a personalisable product
// arrives empty. Optional names are asked too: nobody can tell whether the buyer wanted one.
export function shopAppGap(line: LineData, siblings: Pick<LineData, 'customAttributesJson' | 'customallFieldsJson'>[]): CustomGap | null {
  if (personalised(line)) return null
  const done = siblings.filter(personalised)
  if (!done.length && !/personali[sz]|custom/i.test(line.productTitle)) return null
  const fields = siblingFields(done)
  return { kind: 'SHOP_APP', fields: fields.length ? fields : ['Custom Name'] }
}

function siblingsOf(line: { id: string; sku: string | null }) {
  const parent = line.sku?.split('-')[0]
  return parent
    ? prisma.orderLine.findMany({ where: { sku: { startsWith: parent }, NOT: { id: line.id } }, orderBy: { order: { placedAt: 'desc' } }, take: SIBLINGS, select: { customAttributesJson: true, customallFieldsJson: true } })
    : Promise.resolve([])
}

// Owner 11/08: only Shop app orders placed from shopAppVerifyFrom (a Vietnam day) are questioned, so a customer whose
// order is already being made is never asked about it.
const shopAppFrom = (from: string | null) => (from ? new Date(`${from}T00:00:00+07:00`) : null)
const inShopAppWindow = (order: { placedAt: Date }, from: Date | null) => !from || order.placedAt >= from

async function gapOf(order: { salesChannel: string | null; placedAt: Date }, line: LineData & { id: string }, from: Date | null = null): Promise<CustomGap | null> {
  const nameGap = customGap(line, [])
  if (nameGap?.kind === 'NAME_MISSING') return nameGap
  return isShopApp(order.salesChannel) && inShopAppWindow(order, from) ? shopAppGap(line, await siblingsOf(line)) : null
}

const productName = (title: string) => title.replace(/[\s-]*\b(DN|TN|PK)\d{6,}\s*$/i, '').trim()
const describe = (gap: CustomGap) => gap.kind === 'NAME_MISSING'
  ? 'khách bật in tên nhưng tên không vào đơn'
  : gap.kind === 'SHOP_APP'
    ? `mua qua Shop app nên đơn không có phần custom; cần hỏi khách: ${gap.fields.join(', ')}`
    : `đơn không có phần custom (thường do mua qua Shop app), trong khi đơn khác của sản phẩm này có: ${gap.fields.join(', ')}`

async function hasVerification(taskKey: string, orderNumber: string): Promise<boolean> {
  const found = await prisma.csTask.findFirst({
    where: { OR: [{ designTaskKey: taskKey }, { orderNumber, type: { in: BLOCKING_TYPES }, status: { in: OPEN_STATUSES } }] },
    select: { id: true },
  })
  return !!found
}

async function openTask(data: { orderNumber: string; designTaskKey: string; detail: string }, now: Date): Promise<CsTask> {
  const meta = TASK_META.VERIFY_CUSTOM
  return prisma.csTask.create({
    data: {
      ...data, type: 'VERIFY_CUSTOM', dept: meta.dept, priority: meta.priority, source: 'AGENT',
      dueAt: new Date(now.getTime() + DUE_HOURS * 3600_000), createdAt: now,
      events: { create: { kind: 'CREATED', body: data.detail, toStatus: 'NEW', authorName: 'Hệ thống', createdAt: now } },
    },
  })
}

// Opens a "Xác minh custom" task for each line still at the design stage that cannot be printed as ordered, and holds its
// design task on "Đang hỏi khách" (as the designer's own Hỏi khách button does) so nobody prints a guess. A design task a
// designer already moved to "Đang hỏi khách" gets its CS task too, carrying the designer's question.
export async function openCustomVerifications(now = new Date()): Promise<{ opened: number }> {
  let opened = 0
  const from = shopAppFrom((await getCsSettings()).shopAppVerifyFrom)
  const orders = await prisma.order.findMany({
    where: { placedAt: { gte: new Date(now.getTime() - WINDOW_DAYS * 86400_000) }, exportedAt: null, pipelineStatus: { notIn: SHIPPED_PIPELINE }, OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { not: 'FULFILLED' } }] },
    include: { lines: true, designTasks: { where: { status: { in: CATCHABLE } } } },
  })
  for (const order of orders) {
    for (const dt of order.designTasks) {
      const line = order.lines.find(l => l.shopifyLineId === dt.shopifyLineId)
      if (!line || line.sku?.startsWith('ADDON-')) continue
      if (await hasVerification(dt.taskKey, order.shopifyOrderNumber)) continue
      // An empty line alone proves nothing (a buyer who skipped an optional name leaves one too); only the Shop app,
      // which never shows the personalisation form, turns it into a question.
      const gap = await gapOf(order, line, from)
      if (!gap) continue
      await openTask({
        orderNumber: order.shopifyOrderNumber, designTaskKey: dt.taskKey,
        detail: `Xác minh custom ${dt.taskKey}: ${describe(gap)}. Sản phẩm: ${line.productTitle}${line.variantTitle ? ` (${line.variantTitle})` : ''}. Email khách: ${order.customerEmail ?? '—'}. ${gap.kind === 'SHOP_APP' ? 'Agent tự gửi email hỏi khách và đọc câu trả lời; câu trả lời chưa rõ thì CS xử lý.' : 'Gửi email hỏi khách bằng nút "Soạn email xác minh"; khách trả lời thì ghi câu trả lời và chuyển task sang Xong để design làm tiếp.'}`,
      }, now)
      if (HOLDABLE.includes(dt.status) || (gap.kind === 'SHOP_APP' && dt.status === 'REVIEW')) {
        await prisma.designTask.update({
          where: { id: dt.id },
          data: { status: 'ASK_CUSTOMER', prevStatus: dt.status, events: { create: { type: 'ASK', message: `Hỏi khách: Xác minh custom — ${describe(gap)}`, createdAt: now } } },
        })
      }
      opened += 1
    }
  }

  const asking = await prisma.designTask.findMany({
    where: { status: 'ASK_CUSTOMER', order: { placedAt: { gte: new Date(now.getTime() - ASK_WINDOW_DAYS * 86400_000) } } },
    include: { order: { include: { lines: true } }, events: { where: { type: 'ASK' }, orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  for (const dt of asking) {
    if (await hasVerification(dt.taskKey, dt.order.shopifyOrderNumber)) continue
    const line = dt.order.lines.find(l => l.shopifyLineId === dt.shopifyLineId)
    const question = (dt.events[0]?.message ?? '').replace(/^Hỏi khách:\s*/, '') || 'designer cần hỏi khách'
    await openTask({
      orderNumber: dt.order.shopifyOrderNumber, designTaskKey: dt.taskKey,
      detail: `Designer hỏi khách (${dt.taskKey}): ${question}. Sản phẩm: ${line?.productTitle ?? '—'}${line?.variantTitle ? ` (${line.variantTitle})` : ''}. Email khách: ${dt.order.customerEmail ?? '—'}. Hỏi khách, ghi câu trả lời rồi chuyển task sang Xong để design làm tiếp.`,
    }, now)
    opened += 1
  }
  return { opened }
}

async function taskContext(taskId: string) {
  const task = await prisma.csTask.findUniqueOrThrow({ where: { id: taskId } })
  if (task.type !== 'VERIFY_CUSTOM') throw new Error('Task này không phải xác minh custom')
  const dt = task.designTaskKey ? await prisma.designTask.findUnique({ where: { taskKey: task.designTaskKey } }) : null
  const order = dt
    ? await prisma.order.findUnique({ where: { id: dt.orderId }, include: { lines: true } })
    : task.orderNumber ? await prisma.order.findFirst({ where: { shopifyOrderNumber: task.orderNumber }, include: { lines: true } }) : null
  if (!order) throw new Error('Không tìm thấy đơn của task')
  const line = (dt && order.lines.find(l => l.shopifyLineId === dt.shopifyLineId)) ?? order.lines.find(l => !l.sku?.startsWith('ADDON-')) ?? order.lines[0]
  return { task, order, line }
}

const paragraphs = (...ps: string[]) => ps.filter(Boolean).join('\n\n')
const isNameField = (f: string) => /name|text|personali/i.test(f)
const askList = (fields: string[]) => fields.map(f => `- ${f}${isNameField(f) ? ' (optional, at no extra charge)' : ''}`).join('\n')
const andList = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
const firstName = (order: { customerName: string | null; shippingName: string | null }) => (order.customerName ?? order.shippingName ?? '').trim().split(/\s+/)[0] || 'there'

export async function verifyEmailDraft(taskId: string): Promise<{ to: string | null; subject: string; body: string }> {
  const { task, order, line } = await taskContext(taskId)
  const first = firstName(order)
  const item =`${productName(line.productTitle)}${line.variantTitle ? ` (${line.variantTitle})` : ''}`
  const gap = (await gapOf(order, line)) ?? customGap(line, await siblingsOf(line))
  const ask = gap?.kind === 'NAME_MISSING'
    ? "You chose to add a custom name, but the name itself didn't come through with your order. What name would you like printed on it? Please type it exactly as you want it to appear, including capital letters."
    : gap?.kind === 'CUSTOM_MISSING' || gap?.kind === 'SHOP_APP'
      ? `Your order came through without the personalisation choices from our product page (this can happen when ordering through the Shop app), so we don't have them yet. Could you reply with:\n${askList(gap.fields)}`
      : 'Before we print it, we would like to double-check one detail of your personalisation: [CS: write the question here].'
  return {
    to: order.customerEmail,
    subject: `A quick question about your order ${task.orderNumber ?? order.shopifyOrderNumber}`,
    body: paragraphs(
      `Hi ${first},`,
      `Thank you for your order! We're getting your ${item} ready and want to make sure it comes out exactly the way you want.`,
      ask,
      "We're holding your item so nothing is printed until we hear from you, and we'll start production as soon as you reply.",
      'Warm regards,\nLitzzy Support',
    ),
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const toHtml = (text: string) => text.trim().split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')

export type OutboundPayload = { email: string; subject: string; description: string; email_config_id: number; status: number; priority: number; tags: string[]; custom_fields: Record<string, string> }

export async function sendVerifyEmail(
  taskId: string, email: { subject: string; body: string }, user: Actor,
  deps: { fd: { outboundEmail(p: OutboundPayload): Promise<{ id: number }> }; emailConfigId: number }, now = new Date(),
): Promise<{ fdTicketId: number }> {
  const { task, order } = await taskContext(taskId)
  if (!order.customerEmail) throw new Error('Đơn không có email khách')
  const subject = email.subject?.trim()
  const body = email.body?.trim()
  if (!subject || !body) throw new Error('Thiếu tiêu đề hoặc nội dung email')
  const sent = await deps.fd.outboundEmail({
    email: order.customerEmail, subject, description: toHtml(body), email_config_id: deps.emailConfigId, status: 6, priority: 2,
    tags: ['em-verify-custom'], custom_fields: { cf_order_id: task.orderNumber ?? order.shopifyOrderNumber },
  })
  await prisma.csTask.update({
    where: { id: task.id },
    data: {
      status: 'WAITING',
      events: { create: [
        { kind: 'STATUS', body: `Đã gửi email xác minh tới ${order.customerEmail} (Freshdesk #${sent.id})`, fromStatus: task.status, toStatus: 'WAITING', authorId: user.id, authorName: user.name, createdAt: now },
        { kind: 'COMMENT', body: `${subject}\n\n${body}`, authorId: user.id, authorName: user.name, createdAt: now },
      ] },
    },
  })
  return { fdTicketId: sent.id }
}

const mmdd = (d: Date) => d.toLocaleDateString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', month: '2-digit', day: '2-digit' })

// The customer's answer goes to the designer's "Ghi chú CS" and the held design task carries on from where it stopped.
export async function releaseVerifiedDesign(task: Pick<CsTask, 'designTaskKey'>, answer: string, user: Actor, now = new Date()): Promise<void> {
  if (!task.designTaskKey) return
  const dt = await prisma.designTask.findUnique({ where: { taskKey: task.designTaskKey } })
  if (!dt) return
  const line = await prisma.orderLine.findFirst({ where: { orderId: dt.orderId, shopifyLineId: dt.shopifyLineId } })
  if (line && answer) {
    const entry = `Khách xác nhận (${mmdd(now)}, ${user.name}): ${answer}`
    await prisma.orderLine.update({ where: { id: line.id }, data: { designNote: line.designNote ? `${line.designNote}\n${entry}` : entry } })
  }
  if (dt.status === 'ASK_CUSTOMER') {
    await prisma.designTask.update({
      where: { id: dt.id },
      data: { status: dt.prevStatus ?? 'NEW', prevStatus: null, events: { create: { type: 'STATUS', message: `Tiếp tục sau khi khách xác nhận (CS): ${answer || 'không có ghi chú'}`, actorId: user.id, createdAt: now } } },
    })
  }
}

const SENT_MARK = 'Đã gửi email xác minh'
const TICKET_MARK = 'Không tự gửi email xác minh'

// Owner 11/08: Shop app orders are verified without a CS click. One email per customer covers every waiting line, each
// line is asked once, and a customer already talking to CS about that order is left to the ticket.
export async function sendShopAppVerifications(
  deps: { fd: { outboundEmail(p: OutboundPayload): Promise<{ id: number }> }; emailConfigId: number }, now = new Date(),
): Promise<{ emailed: number }> {
  const settings = await getCsSettings()
  if (!settings.autoVerifyShopApp || settings.killSwitch) return { emailed: 0 }
  const from = shopAppFrom(settings.shopAppVerifyFrom)
  const tasks = await prisma.csTask.findMany({ where: { type: 'VERIFY_CUSTOM', status: 'NEW', designTaskKey: { not: null } }, include: { events: true }, orderBy: { createdAt: 'asc' } })
  type Item = { task: (typeof tasks)[number]; order: Awaited<ReturnType<typeof taskContext>>['order']; line: Awaited<ReturnType<typeof taskContext>>['line']; gap: CustomGap }
  const groups = new Map<string, Item[]>()
  for (const task of tasks) {
    if (task.events.some(e => e.body.startsWith(SENT_MARK))) continue
    const { order, line } = await taskContext(task.id)
    if (!isShopApp(order.salesChannel) || !order.customerEmail || !inShopAppWindow(order, from)) continue
    const open = await prisma.csTicket.findFirst({ where: { orderNumber: order.shopifyOrderNumber, fdStatus: { notIn: [4, 5] }, NOT: { fdTags: { contains: 'em-verify-custom' } } }, select: { fdTicketId: true } })
    if (open) {
      const note = `${TICKET_MARK}: khách đang có ticket mở về đơn này (Freshdesk #${open.fdTicketId}), CS hỏi trong ticket đó.`
      if (!task.events.some(e => e.body === note)) await prisma.csTaskEvent.create({ data: { taskId: task.id, kind: 'COMMENT', body: note, authorName: AGENT.name, createdAt: now } })
      continue
    }
    const gap = shopAppGap(line, await siblingsOf(line)) ?? { kind: 'SHOP_APP' as const, fields: ['Custom Name'] }
    const key = order.customerEmail.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), { task, order, line, gap }])
  }
  let emailed = 0
  for (const items of Array.from(groups.values())) {
    const orders = Array.from(new Set(items.map(i => i.order.shopifyOrderNumber)))
    const many = orders.length > 1
    const subject = `A quick question about your order${many ? 's' : ''} ${andList(orders)}`
    const body = paragraphs(
      `Hi ${firstName(items[0].order)},`,
      `Thank you for your order${many ? 's' : ''}! We're getting ${many ? 'them' : 'it'} ready and want to make sure everything comes out exactly the way you want.`,
      `Your order${many ? 's' : ''} came through the Shop app, which doesn't pass along the personalisation choices from our product page, so we don't have them yet. Could you reply with the details below?`,
      ...items.map(i => `Order ${i.order.shopifyOrderNumber}: ${productName(i.line.productTitle)}${i.line.variantTitle ? ` (${i.line.variantTitle})` : ''}\n${askList(i.gap.fields)}`),
      items.some(i => i.gap.fields.some(isNameField)) ? "If you'd rather not have a name on an item, just tell us and we'll print it without one." : '',
      `We're holding your order${many ? 's' : ''} so nothing is printed until we hear from you, and we'll start production as soon as you reply.`,
      'Warm regards,\nLitzzy Support',
    )
    const email = items[0].order.customerEmail!
    const sent = await deps.fd.outboundEmail({
      email, subject, description: toHtml(body), email_config_id: deps.emailConfigId, status: 6, priority: 2,
      tags: ['em-verify-custom', 'em-shop-app'], custom_fields: { cf_order_id: orders[0] },
    })
    for (const i of items) {
      await prisma.csTask.update({
        where: { id: i.task.id },
        data: {
          status: 'WAITING',
          events: { create: [
            { kind: 'STATUS', body: `${SENT_MARK} tới ${email} (Freshdesk #${sent.id}, tự động cho đơn Shop app)`, fromStatus: 'NEW', toStatus: 'WAITING', authorName: AGENT.name, createdAt: now },
            { kind: 'COMMENT', body: `${subject}\n\n${body}`, authorName: AGENT.name, createdAt: now },
          ] },
        },
      })
    }
    emailed += 1
  }
  return { emailed }
}

const orderKey = (n: string) => (n.trim().startsWith('#') ? n.trim() : `#${n.trim()}`).toUpperCase()

// What the agent read in a reply to a verification email. A clear answer closes the line's task and releases its design;
// anything less, or an order with several lines still waiting, stays with CS with the answer noted once.
export async function applyCustomAnswers(answers: { orderNumber: string; answer: string; clear: boolean }[], now = new Date()): Promise<number> {
  let closed = 0
  for (const a of answers) {
    const answer = a.answer?.trim()
    if (!a.orderNumber?.trim() || !answer) continue
    const tasks = await prisma.csTask.findMany({ where: { type: 'VERIFY_CUSTOM', orderNumber: orderKey(a.orderNumber), status: { in: OPEN_STATUSES } }, include: { events: true } })
    if (!tasks.length) continue
    if (a.clear && tasks.length === 1) {
      const task = tasks[0]
      await prisma.csTask.update({
        where: { id: task.id },
        data: { status: 'DONE', doneAt: now, events: { create: { kind: 'STATUS', body: `Khách trả lời: ${answer}`, fromStatus: task.status, toStatus: 'DONE', authorId: AGENT.id, authorName: AGENT.name, createdAt: now } } },
      })
      await releaseVerifiedDesign(task, answer, AGENT, now)
      closed += 1
      continue
    }
    const note = a.clear
      ? `Khách đã trả lời nhưng đơn còn ${tasks.length} dòng chờ xác minh, CS ghi câu trả lời cho từng dòng: ${answer}`
      : `Khách trả lời nhưng chưa rõ, CS xem lại: ${answer}`
    for (const t of tasks) {
      if (!t.events.some(e => e.body === note)) await prisma.csTaskEvent.create({ data: { taskId: t.id, kind: 'COMMENT', body: note, authorId: AGENT.id, authorName: AGENT.name, createdAt: now } })
    }
  }
  return closed
}
