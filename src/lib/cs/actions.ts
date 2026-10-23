import { createHash } from 'crypto'
import { prisma } from '@/lib/db'
import type { CsAnalysis, CsMessage, CsTicket } from '@/generated/prisma/client'
import type { FreshdeskClient } from '@/lib/cs/freshdesk'
import type { CsSettings } from '@/lib/cs/settings'
import { tagsFor, urgencyToPriority, type CsCategory, type CsUrgency } from '@/lib/cs/triage'
import { CATEGORY_LABELS, URGENCY_LABELS } from '@/lib/cs/labels'

export type Notifier = (text: string) => Promise<unknown>

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const ticketUrl = (appUrl: string, ticket: Pick<CsTicket, 'id'>) => `${appUrl.replace(/\/$/, '')}/cs/${ticket.id}`

export function analysisHash(a: Pick<CsAnalysis, 'inputHash' | 'urgency' | 'category'>, orderNumber: string | null = null): string {
  return createHash('sha1').update([a.category, a.urgency, orderNumber ?? '', a.inputHash].join('|')).digest('hex')
}

export function textToHtml(text: string): string {
  return text.trim().split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
}

export function noteHtml(a: CsAnalysis, ticket: CsTicket, appUrl: string): string {
  const cat = CATEGORY_LABELS[a.category as CsCategory] ?? a.category
  return [
    `<p><b>Ecom Manager</b> · ${esc(URGENCY_LABELS[a.urgency as CsUrgency] ?? a.urgency)} · ${esc(cat)}${ticket.orderNumber ? ` · ${esc(ticket.orderNumber)}` : ''}</p>`,
    `<p>${esc(a.summary).replace(/\n/g, '<br>')}</p>`,
    `<p><b>Đề xuất:</b> ${esc(a.proposal).replace(/\n/g, '<br>')}</p>`,
    `<p><a href="${ticketUrl(appUrl, ticket)}">${ticketUrl(appUrl, ticket)}</a></p>`,
  ].join('')
}

export function telegramText(a: CsAnalysis, ticket: CsTicket, appUrl: string): string {
  const badge = a.urgency === 'URGENT' ? '🔴 URGENT' : a.urgency === 'HIGH' ? '🟠 HIGH' : a.urgency
  const cat = CATEGORY_LABELS[a.category as CsCategory] ?? a.category
  return [
    `<b>${badge}</b> · ${esc(cat)}${ticket.orderNumber ? ` · <b>${esc(ticket.orderNumber)}</b>` : ''}`,
    `#${ticket.fdTicketId} ${esc(ticket.subject)}`,
    esc(a.summary),
    `<a href="${ticketUrl(appUrl, ticket)}">Mở trong tool</a>`,
  ].join('\n')
}

export async function notify(notifier: Notifier, ticket: CsTicket, a: CsAnalysis, settings: CsSettings, appUrl: string): Promise<boolean> {
  if (!settings.notifyLevels.includes(a.urgency)) return false
  if (ticket.lastNoteHash === analysisHash(a, ticket.orderNumber)) return false
  await notifier(telegramText(a, ticket, appUrl))
  return true
}

export async function writeBack(fd: Pick<FreshdeskClient, 'update' | 'note'>, ticket: CsTicket, a: CsAnalysis, settings: CsSettings, appUrl: string): Promise<{ noted: boolean }> {
  const existingTags: string[] = (() => { try { return JSON.parse(ticket.fdTags) } catch { return [] } })()
  const patch: Parameters<FreshdeskClient['update']>[1] = {
    priority: urgencyToPriority(a.urgency as CsUrgency),
    tags: tagsFor(a.category as CsCategory, a.urgency as CsUrgency, existingTags),
  }
  if (ticket.orderNumber && (ticket.orderMatch === 'EXACT' || ticket.orderMatch === 'BY_EMAIL')) patch.custom_fields = { cf_order_id: ticket.orderNumber }
  await fd.update(ticket.fdTicketId, patch)
  await prisma.csTicket.update({ where: { id: ticket.id }, data: { fdPriority: patch.priority, fdTags: JSON.stringify(patch.tags) } })
  const hash = analysisHash(a, ticket.orderNumber)
  if (ticket.lastNoteHash === hash) return { noted: false }
  await fd.note(ticket.fdTicketId, noteHtml(a, ticket, appUrl))
  await prisma.csTicket.update({ where: { id: ticket.id }, data: { lastNoteHash: hash } })
  void settings
  return { noted: true }
}

async function storeOutgoing(ticket: CsTicket, fdId: number, author: 'AGENT' | 'STAFF', body: string, isPrivate: boolean, now: Date): Promise<CsMessage> {
  const msg = await prisma.csMessage.create({
    data: { ticketId: ticket.id, fdConversationId: String(fdId), author, private: isPrivate, bodyText: body, bodyHtml: textToHtml(body), fromEmail: 'support@litzzy.com', createdAt: now },
  })
  if (!isPrivate) await prisma.csTicket.update({ where: { id: ticket.id }, data: { lastReplyAt: now } })
  return msg
}

export async function autoReply(fd: Pick<FreshdeskClient, 'reply' | 'update'>, ticket: CsTicket, a: CsAnalysis, now = new Date()): Promise<CsMessage> {
  if (!a.draftReply) throw new Error('autoReply called without a draft')
  const sent = await fd.reply(ticket.fdTicketId, textToHtml(a.draftReply))
  const existingTags: string[] = (() => { try { return JSON.parse(ticket.fdTags) } catch { return [] } })()
  const tags = existingTags.includes('em-auto-replied') ? existingTags : [...existingTags, 'em-auto-replied']
  await fd.update(ticket.fdTicketId, { status: 6, tags })
  const msg = await storeOutgoing(ticket, sent.id, 'AGENT', a.draftReply, false, now)
  await prisma.csTicket.update({ where: { id: ticket.id }, data: { autoReplied: true, needsHuman: false, fdStatus: 6, fdTags: JSON.stringify(tags) } })
  return msg
}

export async function sendStaffReply(fd: Pick<FreshdeskClient, 'reply' | 'note' | 'update'>, ticket: CsTicket, body: string, opts: { private: boolean }, now = new Date()): Promise<CsMessage> {
  const html = textToHtml(body)
  const sent = opts.private ? await fd.note(ticket.fdTicketId, html) : await fd.reply(ticket.fdTicketId, html)
  if (!opts.private) {
    await fd.update(ticket.fdTicketId, { status: 6 })
    await prisma.csTicket.update({ where: { id: ticket.id }, data: { fdStatus: 6, needsHuman: false } })
  }
  return storeOutgoing(ticket, sent.id, 'STAFF', body, opts.private, now)
}

export async function dailyDigest(notifier: Notifier, appUrl: string): Promise<boolean> {
  const rows = await prisma.csTicket.groupBy({
    by: ['urgency'],
    where: { needsHuman: true, resolvedInTool: false, fdStatus: { notIn: [4, 5] } },
    _count: { _all: true },
  })
  if (!rows.length) return false
  const order: CsUrgency[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW']
  const lines = order
    .map(u => ({ u, n: rows.find(r => r.urgency === u)?._count._all ?? 0 }))
    .filter(x => x.n > 0)
    .map(x => `${x.u}: ${x.n}`)
  const unknown = rows.find(r => !r.urgency)?._count._all ?? 0
  if (unknown) lines.push(`Chưa phân loại: ${unknown}`)
  await notifier([`<b>CS sáng nay</b> — ticket chờ xử lý`, ...lines, `<a href="${appUrl.replace(/\/$/, '')}/cs">Mở danh sách</a>`].join('\n'))
  return true
}
