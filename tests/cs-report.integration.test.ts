import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import type { Llm } from '@/lib/llm/types'
import { buildReportInput, generateReport } from '@/lib/cs/report'
import { saveCsSettings } from '@/lib/cs/settings'

const T = (iso: string) => new Date(iso)
const period = { from: T('2026-10-19T17:00:00Z'), to: T('2026-10-25T16:59:59Z') }

beforeAll(async () => {
  await prisma.csTicket.deleteMany({})
  await prisma.csPerformanceReport.deleteMany({})
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'cs.llmCalls.' } } })
  await saveCsSettings({ llmDailyCallCap: 500 })
  const t = await prisma.csTicket.create({ data: { fdTicketId: 501, subject: 'rep', fdStatus: 5, fdPriority: 1, fdCreatedAt: T('2026-10-20T08:00:00Z'), fdUpdatedAt: T('2026-10-20T08:00:00Z'), lastCustomerAt: T('2026-10-20T08:00:00Z'), reviewedAt: T('2026-10-21T00:00:00Z') } })
  const c = await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: 'rep-0', author: 'CUSTOMER', bodyText: 'wrong name', createdAt: T('2026-10-20T08:00:00Z'), sentiment: 'FRUSTRATED' } })
  const s = await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: 'rep-1', author: 'STAFF', bodyText: 'Please send a photo of the label.', createdAt: T('2026-10-21T20:00:00Z') } })
  void c
  await prisma.csReplyReview.create({ data: { ticketId: t.id, messageId: s.id, score: 2, issues: JSON.stringify(['ASKED_PHOTO_AS_PROOF', 'TOO_SLOW']), reason: 'Xin ảnh để chứng minh: "Please send a photo"', rewrite: 'So sorry — where is it wrong? We will remake it.', model: 'm' } })
})
afterAll(async () => { await prisma.csTicket.deleteMany({}); await prisma.csPerformanceReport.deleteMany({}) })

describe('performance report', () => {
  it('buildReportInput aggregates metrics, issue counts, histogram and worst replies', async () => {
    const i = await buildReportInput(period)
    expect(i.metrics.staff.firstResponse.count).toBe(1)
    expect(i.issueCounts).toEqual({ ASKED_PHOTO_AS_PROOF: 1, TOO_SLOW: 1 })
    expect(i.scoreHistogram).toEqual([0, 1, 0, 0, 0])
    expect(i.worst[0].quote).toContain('send a photo')
    expect(i.worst[0].issues).toContain('ASKED_PHOTO_AS_PROOF')
  })
  it('generateReport stores the write-up and sends a summary', async () => {
    const llm = {
      lastUser: '',
      async complete(i: any) { llm.lastUser = i.user; return { output: { weaknesses: [{ title: 'Xin ảnh để chứng minh', numbers: '1/1 thư', examples: ['"Please send a photo of the label."'] }], goodExample: 'So sorry — where is it wrong?', habits: ['Hỏi sai ở đâu, không xin ảnh', 'Trả lời trong 24h', 'Chốt bước tiếp theo'], progress: 'Chưa có kỳ trước để so.' }, tokensIn: 1, tokensOut: 1 } },
      async analyze(): Promise<any> { throw new Error('not used') },
    } as Llm & { lastUser: string }
    const texts: string[] = []
    const r = await generateReport(period, 'MANUAL', { llm, notifier: async t => { texts.push(t) }, appUrl: 'http://app.test' })
    expect(r.kind).toBe('MANUAL')
    expect(JSON.parse(r.metricsJson).staff.firstResponse.count).toBe(1)
    expect(r.body).toContain('Xin ảnh để chứng minh')
    expect(r.body).toContain('Hỏi sai ở đâu, không xin ảnh')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('Xin ảnh để chứng minh')
    expect(llm.lastUser).toContain('ASKED_PHOTO_AS_PROOF')
    expect(await prisma.csPerformanceReport.count()).toBe(1)
  })
})
