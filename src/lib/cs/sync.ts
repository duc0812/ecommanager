import { prisma } from '@/lib/db'
import type { FdConversation, FdTicket, FreshdeskClient } from '@/lib/cs/freshdesk'
import { FreshdeskBudgetExceeded } from '@/lib/cs/freshdesk'
import { getCsSettings, saveCsSettings, type CsSettings } from '@/lib/cs/settings'
import { extractOrderNumbers } from '@/lib/cs/order-context'

export type FdLike = Pick<FreshdeskClient, 'listTickets' | 'getConversations' | 'requests'>
export type MessageAuthor = 'CUSTOMER' | 'STAFF' | 'AGENT' | 'SYSTEM' | 'SKIP'

const DEFAULT_SINCE_DAYS = 7

export function authorOf(c: FdConversation, s: Pick<CsSettings, 'supportAgentId' | 'ignoredAgentIds'>, knownAgentIds: Set<string>): MessageAuthor {
  if (knownAgentIds.has(String(c.id))) return 'AGENT'
  if (c.incoming) return 'CUSTOMER'
  if (c.user_id === s.supportAgentId) return 'STAFF'
  if (c.private) return 'SKIP'
  return 'SYSTEM'
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function minusOneSecond(iso: string): string {
  return new Date(new Date(iso).getTime() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

type Existing = { id: string; orderNumber: string | null; fdUpdatedAt: Date; lastCustomerAt: Date | null; closedAt: Date | null; fdReopenedAt: Date | null; reopenCount: number }

const at = (v: string | null | undefined) => (v ? new Date(v) : null)

async function upsertTicket(t: FdTicket, existing: Existing | null) {
  const closedNow = t.status === 4 || t.status === 5
  const fdResolvedAt = at(t.stats?.resolved_at)
  const fdClosedAt = at(t.stats?.closed_at)
  const fdReopenedAt = at(t.stats?.reopened_at)
  const reopenedAdvanced = !!fdReopenedAt && (!existing?.fdReopenedAt || fdReopenedAt.getTime() > existing.fdReopenedAt.getTime())
  const closedAt = closedNow ? ((reopenedAdvanced || !existing?.closedAt) ? (fdResolvedAt ?? fdClosedAt ?? new Date(t.updated_at)) : existing.closedAt) : (reopenedAdvanced ? null : existing?.closedAt ?? null)
  const data = {
    fdFirstRespondedAt: at(t.stats?.first_responded_at),
    fdResolvedAt,
    fdClosedAt,
    fdReopenedAt,
    closedAt,
    reopenCount: (existing?.reopenCount ?? 0) + (reopenedAdvanced ? 1 : 0),
    subject: t.subject ?? '',
    fdStatus: t.status,
    fdPriority: t.priority,
    fdTags: JSON.stringify(t.tags ?? []),
    requesterEmail: t.requester?.email ?? null,
    requesterName: t.requester?.name ?? null,
    fdCreatedAt: new Date(t.created_at),
    fdUpdatedAt: new Date(t.updated_at),
  }
  const hinted = extractOrderNumbers(`${t.custom_fields?.cf_order_id ?? ''}
${t.subject ?? ''}`)[0] ?? null
  const ticket = existing
    ? await prisma.csTicket.update({ where: { id: existing.id }, data: { ...data, orderNumber: existing.orderNumber ?? hinted } })
    : await prisma.csTicket.create({ data: { ...data, fdTicketId: t.id, orderNumber: hinted } })
  const descId = `desc-${t.id}`
  const descText = t.description_text?.trim() || htmlToText(t.description)
  const descExists = await prisma.csMessage.findUnique({ where: { fdConversationId: descId } })
  if (!descExists) {
    await prisma.csMessage.create({
      data: { ticketId: ticket.id, fdConversationId: descId, author: 'CUSTOMER', private: false, bodyText: descText, bodyHtml: t.description ?? null, fromEmail: t.requester?.email ?? null, createdAt: new Date(t.created_at) },
    })
  }
  return ticket
}

async function upsertConversations(ticketId: string, convs: FdConversation[], settings: CsSettings) {
  const known = new Set(
    (await prisma.csMessage.findMany({ where: { ticketId, author: 'AGENT', fdConversationId: { not: null } }, select: { fdConversationId: true } }))
      .map(m => m.fdConversationId!),
  )
  for (const c of convs) {
    const author = authorOf(c, settings, known)
    if (author === 'SKIP') continue
    const id = String(c.id)
    const existing = await prisma.csMessage.findUnique({ where: { fdConversationId: id } })
    if (existing) continue
    await prisma.csMessage.create({
      data: { ticketId, fdConversationId: id, author, private: !!c.private, bodyText: c.body_text?.trim() || htmlToText(c.body), bodyHtml: c.body ?? null, fromEmail: c.from_email ?? null, createdAt: new Date(c.created_at) },
    })
  }
}

async function refreshTimestamps(ticketId: string) {
  const [lastCustomer, lastReply] = await Promise.all([
    prisma.csMessage.findFirst({ where: { ticketId, author: 'CUSTOMER' }, orderBy: { createdAt: 'desc' } }),
    prisma.csMessage.findFirst({ where: { ticketId, author: { in: ['STAFF', 'AGENT', 'SYSTEM'] }, private: false }, orderBy: { createdAt: 'desc' } }),
  ])
  await prisma.csTicket.update({ where: { id: ticketId }, data: { lastCustomerAt: lastCustomer?.createdAt ?? null, lastReplyAt: lastReply?.createdAt ?? null } })
  return lastCustomer?.createdAt ?? null
}

function reopenedAdvanced(t: FdTicket, existing: { fdReopenedAt: Date | null }): boolean {
  const r = at(t.stats?.reopened_at)
  return !!r && (!existing.fdReopenedAt || r.getTime() > existing.fdReopenedAt.getTime())
}

async function detectReopen(ticketId: string, lastCustomerAt: Date | null) {
  if (!lastCustomerAt) return
  const t = await prisma.csTicket.findUnique({ where: { id: ticketId }, select: { closedAt: true, reopenCount: true, fdStatus: true } })
  if (!t?.closedAt || lastCustomerAt.getTime() <= t.closedAt.getTime()) return
  await prisma.csTicket.update({ where: { id: ticketId }, data: { reopenCount: t.reopenCount + 1, closedAt: t.fdStatus === 4 || t.fdStatus === 5 ? t.closedAt : null } })
}

export async function syncTickets(fd: FdLike, opts: { since?: string } = {}): Promise<{ seen: number; changed: string[]; cursor: string | null; partial?: boolean; error?: string }> {
  const settings = await getCsSettings()
  const since = opts.since ?? settings.syncUpdatedSince ?? new Date(Date.now() - DEFAULT_SINCE_DAYS * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  let seen = 0
  const changed: string[] = []
  let lastProcessed: string | null = null
  let error: string | undefined
  let partial = false

  try {
    for (let page = 1; page <= 10; page++) {
      const batch = await fd.listTickets(since, page)
      for (const t of batch) {
        const existing = await prisma.csTicket.findUnique({ where: { fdTicketId: t.id }, select: { id: true, orderNumber: true, fdUpdatedAt: true, lastCustomerAt: true, closedAt: true, fdReopenedAt: true, reopenCount: true } })
        const moved = !existing || existing.fdUpdatedAt.getTime() !== new Date(t.updated_at).getTime()
        const convs = moved ? await fd.getConversations(t.id) : []
        seen += 1
        const ticket = await upsertTicket(t, existing)
        if (moved) await upsertConversations(ticket.id, convs, settings)
        const lastCustomerAt = await refreshTimestamps(ticket.id)
        const grew = !existing || (lastCustomerAt?.getTime() ?? 0) > (existing.lastCustomerAt?.getTime() ?? 0)
        if (grew) changed.push(ticket.id)
        if (grew && existing && !reopenedAdvanced(t, existing)) await detectReopen(ticket.id, lastCustomerAt)
        lastProcessed = t.updated_at
      }
      if (batch.length < 100) break
    }
  } catch (err: any) {
    if (err instanceof FreshdeskBudgetExceeded) partial = true
    else error = err?.message ?? String(err)
  }

  const cursor = lastProcessed ? minusOneSecond(lastProcessed) : since
  if (lastProcessed) await saveCsSettings({ syncUpdatedSince: cursor })
  return { seen, changed, cursor, partial: partial || undefined, error }
}
