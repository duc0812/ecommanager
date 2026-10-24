import { prisma } from '@/lib/db'
import type { CsDirective } from '@/generated/prisma/client'
import type { Llm } from '@/lib/llm/types'
import type { FreshdeskClient } from '@/lib/cs/freshdesk'
import { analyzeTicket } from '@/lib/cs/analyze'
import { writeBack } from '@/lib/cs/actions'
import { getCsSettings } from '@/lib/cs/settings'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function openDirectives(ticketId: string): Promise<CsDirective[]> {
  return prisma.csDirective.findMany({ where: { ticketId, resolvedAt: null }, orderBy: { createdAt: 'asc' } })
}

export async function addDirective(
  ticketId: string,
  body: string,
  user: { id: string; name: string },
  deps: { fd: Pick<FreshdeskClient, 'note'> | null; llm: Llm | null; now?: Date; fdWrite?: Pick<FreshdeskClient, 'update' | 'note'> | null; appUrl?: string },
): Promise<{ directive: CsDirective; analysed: boolean; noteError: string | null; analysisError: string | null }> {
  const now = deps.now ?? new Date()
  const text = body.trim()
  if (!text) throw new Error('Nội dung chỉ đạo trống')
  const ticket = await prisma.csTicket.findUniqueOrThrow({ where: { id: ticketId } })
  let fdNoteId: string | null = null
  let noteError: string | null = null
  if (deps.fd) {
    try {
      const note = await deps.fd.note(ticket.fdTicketId, `<p><b>Chỉ đạo admin (${esc(user.name)})</b></p><p>${esc(text).replace(/\n/g, '<br>')}</p>`)
      fdNoteId = String(note.id)
    } catch (err: any) { noteError = err?.message ?? String(err) }
  }
  const directive = await prisma.csDirective.create({ data: { ticketId, body: text, createdById: user.id, createdByName: user.name, createdAt: now, fdNoteId } })
  let analysed = false
  let analysisError: string | null = null
  if (deps.llm) {
    try {
      const analysis = await analyzeTicket(ticketId, { llm: deps.llm, now, force: true })
      analysed = true
      if (deps.fdWrite) {
        const settings = await getCsSettings()
        const fresh = await prisma.csTicket.findUniqueOrThrow({ where: { id: ticketId } })
        await writeBack(deps.fdWrite, fresh, analysis, settings, deps.appUrl ?? '')
      }
    } catch (err: any) { analysisError = err?.message ?? String(err) }
  }
  return { directive, analysed, noteError, analysisError }
}

export async function resolveDirective(id: string, user: { id: string }, resolved: boolean): Promise<CsDirective> {
  return prisma.csDirective.update({ where: { id }, data: resolved ? { resolvedAt: new Date(), resolvedById: user.id } : { resolvedAt: null, resolvedById: null } })
}
