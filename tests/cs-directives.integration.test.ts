import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import type { Llm } from '@/lib/llm/types'
import { addDirective, resolveDirective } from '@/lib/cs/directives'
import { analyzeTicket } from '@/lib/cs/analyze'
import { buildSystemPrompt, buildUserPrompt } from '@/lib/cs/agent-prompt'
import { saveCsSettings } from '@/lib/cs/settings'

const T = (iso: string) => new Date(iso)

function fakeLlm() {
  const llm = {
    calls: 0,
    lastUser: '',
    async complete(): Promise<any> { throw new Error('not used') },
    async analyze({ user }: { user: string }) {
      llm.calls += 1
      llm.lastUser = user
      return { output: { category: 'WRONG_ITEM', urgency: 'HIGH', sentiment: 'FRUSTRATED', orderNumber: null, summary: 's', facts: [], proposal: 'Resend', citedCaseIds: [], draftReply: 'Hi, we are resending a new one today.', needsHuman: true, needsHumanReason: 'directive', autoReplyEligible: false, autoReplyReason: 'directive' }, tokensIn: 1, tokensOut: 1 }
    },
  }
  return llm as Llm & { calls: number; lastUser: string }
}

function fakeFd() {
  const notes: { id: number; body: string }[] = []
  return { notes, async note(id: number, body: string) { notes.push({ id, body }); return { id: 5000 + notes.length } } }
}

async function mk(fdId: number) {
  const t = await prisma.csTicket.create({ data: { fdTicketId: fdId, subject: `dir ${fdId}`, fdStatus: 2, fdPriority: 1, fdCreatedAt: T('2026-10-20T08:00:00Z'), fdUpdatedAt: T('2026-10-20T08:00:00Z'), lastCustomerAt: T('2026-10-20T08:00:00Z') } })
  await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: `dir-${fdId}`, author: 'CUSTOMER', bodyText: 'The mug arrived broken', createdAt: T('2026-10-20T08:00:00Z') } })
  return t
}

beforeAll(async () => { await saveCsSettings({ llmDailyCallCap: 500 }) })
beforeEach(async () => { await prisma.csTicket.deleteMany({}); await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'cs.llmCalls.' } } }) })
afterAll(async () => { await prisma.csTicket.deleteMany({}) })

describe('prompt', () => {
  it('system prompt tells the model how to treat admin directives', () => {
    const s = buildSystemPrompt([], { productionDays: 5, shippingDays: 15 }).toLowerCase()
    expect(s).toContain('admin directive')
    expect(s).toContain('needshuman')
  })
  it('user prompt lists open directives', () => {
    const p = buildUserPrompt({ ticket: { id: 't', fdTicketId: 1, subject: 's', requesterEmail: null, requesterName: null, fdCreatedAt: new Date() } as any, messages: [], order: { match: 'NONE', order: null, candidates: [] }, previous: [], directives: [{ body: 'Resend a new mug and tell the customer it ships today', createdByName: 'Duc', createdAt: T('2026-10-24T03:00:00Z') }] })
    expect(p).toContain('# Admin directives')
    expect(p).toContain('Resend a new mug')
    expect(p).toContain('Duc')
  })
})

describe('addDirective', () => {
  it('stores the directive, posts a private note to Freshdesk and re-analyses with the directive in the prompt', async () => {
    const t = await mk(901)
    const llm = fakeLlm()
    const fd = fakeFd()
    const r = await addDirective(t.id, 'Resend a new mug and tell the customer it ships today', { id: 'u1', name: 'Duc' }, { fd, llm, now: T('2026-10-24T03:00:00Z') })
    expect(r.directive.body).toContain('Resend')
    expect(r.directive.createdByName).toBe('Duc')
    expect(fd.notes).toHaveLength(1)
    expect(fd.notes[0].id).toBe(901)
    expect(fd.notes[0].body).toContain('Resend a new mug')
    expect(r.directive.fdNoteId).toBe('5001')
    expect(llm.calls).toBe(1)
    expect(llm.lastUser).toContain('Resend a new mug')
    const ticket = await prisma.csTicket.findUnique({ where: { id: t.id }, include: { analyses: true } })
    expect(ticket!.analyses[0].draftReply).toContain('resending')
    expect(ticket!.needsHuman).toBe(true)
  })
  it('a new directive invalidates the analysis cache, a resolved one is left out of the prompt', async () => {
    const t = await mk(902)
    const llm = fakeLlm()
    await analyzeTicket(t.id, { llm })
    expect(llm.calls).toBe(1)
    await analyzeTicket(t.id, { llm })
    expect(llm.calls).toBe(1)
    const r = await addDirective(t.id, 'Offer a reprint, no refund', { id: 'u1', name: 'Duc' }, { fd: null, llm, now: T('2026-10-24T03:00:00Z') })
    expect(llm.calls).toBe(2)
    expect(llm.lastUser).toContain('Offer a reprint')
    await resolveDirective(r.directive.id, { id: 'u2' }, true)
    await analyzeTicket(t.id, { llm, force: true })
    expect(llm.calls).toBe(3)
    expect(llm.lastUser).not.toContain('Offer a reprint')
  })
  it('works without Freshdesk or a model configured', async () => {
    const t = await mk(903)
    const r = await addDirective(t.id, 'Hold until the customer confirms the address', { id: 'u1', name: 'Duc' }, { fd: null, llm: null })
    expect(r.directive.fdNoteId).toBeNull()
    expect(r.analysed).toBe(false)
    expect(await prisma.csDirective.count({ where: { ticketId: t.id } })).toBe(1)
  })
})
