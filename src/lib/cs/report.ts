import { z } from 'zod'
import { prisma } from '@/lib/db'
import type { CsPerformanceReport } from '@/generated/prisma/client'
import type { Llm } from '@/lib/llm/types'
import { withCap } from '@/lib/llm/cap'
import { getCsSettings } from '@/lib/cs/settings'
import { computePerformance, type Period, type PerformanceMetrics } from '@/lib/cs/performance'
import { RUBRIC_LABELS } from '@/lib/cs/review-prompt'
import type { Notifier } from '@/lib/cs/actions'

export const ReportSchema = z.object({
  weaknesses: z.array(z.object({ title: z.string(), numbers: z.string(), examples: z.array(z.string()).max(2) })).max(3),
  goodExample: z.string(),
  habits: z.array(z.string()).max(3),
  progress: z.string(),
})
export type Report = z.infer<typeof ReportSchema>

export type ReportInput = {
  metrics: PerformanceMetrics
  previous: PerformanceMetrics | null
  issueCounts: Record<string, number>
  scoreHistogram: number[]
  worst: { fdTicketId: number; quote: string; issues: string[]; reason: string; rewrite: string | null; score: number }[]
}

export async function buildReportInput(period: Period): Promise<ReportInput> {
  const metrics = await computePerformance(period)
  const span = period.to.getTime() - period.from.getTime()
  const previous = await computePerformance({ from: new Date(period.from.getTime() - span - 1), to: new Date(period.from.getTime() - 1) })
  const reviews = await prisma.csReplyReview.findMany({
    where: { runAt: { gte: new Date(0) }, ticket: { messages: { some: { author: 'CUSTOMER', createdAt: { gte: period.from, lte: period.to } } } } },
    include: { ticket: { select: { fdTicketId: true } } },
  })
  const messages = await prisma.csMessage.findMany({ where: { id: { in: reviews.map(r => r.messageId) } }, select: { id: true, bodyText: true, author: true, source: true } })
  const byId = new Map(messages.map(m => [m.id, m]))
  const staffReviews = reviews.filter(r => { const m = byId.get(r.messageId); return m && m.author === 'STAFF' && m.source !== 'DRAFT_UNCHANGED' })
  const issueCounts: Record<string, number> = {}
  const scoreHistogram = [0, 0, 0, 0, 0]
  for (const r of staffReviews) {
    for (const i of JSON.parse(r.issues) as string[]) if (i !== 'GOOD') issueCounts[i] = (issueCounts[i] ?? 0) + 1
    if (r.score >= 1 && r.score <= 5) scoreHistogram[r.score - 1] += 1
  }
  const worst = [...staffReviews].sort((a, b) => a.score - b.score).slice(0, 8).map(r => ({
    fdTicketId: r.ticket.fdTicketId,
    quote: (byId.get(r.messageId)?.bodyText ?? '').trim().slice(0, 300),
    issues: JSON.parse(r.issues) as string[],
    reason: r.reason,
    rewrite: r.rewrite,
    score: r.score,
  }))
  return { metrics, previous: previous.tickets ? previous : null, issueCounts, scoreHistogram, worst }
}

const fmtD = (d: Date) => d.toLocaleDateString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', month: '2-digit', day: '2-digit', year: 'numeric' })
const h = (n: number | null) => (n === null ? '—' : `${n} h`)
const pct = (n: number | null) => (n === null ? '—' : `${n}%`)

function metricsText(label: string, m: PerformanceMetrics): string {
  const s = m.staff
  return `${label}: ${m.tickets} ticket · phản hồi đầu median ${h(s.firstResponse.medianH)} / p90 ${h(s.firstResponse.p90H)} / quá 24h ${pct(s.firstResponse.over24hPct)} · phản hồi sau median ${h(s.nextResponse.medianH)} · thư/ticket ${s.repliesPerTicket.mean ?? '—'} (>3: ${pct(s.repliesPerTicket.over3Pct)}) · đóng non ${s.prematureCloses.count}/${s.prematureCloses.closedTickets} · cảm xúc sau thư: tốt ${s.sentimentAfterReply.improved} / giữ ${s.sentimentAfterReply.same} / xấu ${s.sentimentAfterReply.worse} · gửi nguyên nháp agent ${s.draftUnchanged}`
}

export function buildReportPrompt(period: Period, i: ReportInput): { system: string; user: string } {
  const system = `Bạn là trưởng bộ phận CSKH của Litzzy (cửa hàng in theo yêu cầu, đặt cảm xúc khách lên trước). Bạn nhận số liệu và các thư bị chấm điểm thấp của một nhân sự CS trong một kỳ, và viết bản đánh giá ngắn, thẳng, có số liệu, để chủ cửa hàng góp ý với nhân sự. Viết tiếng Việt; trích thư gốc bằng tiếng Anh. Trả về JSON đúng schema: weaknesses (tối đa 3: title, numbers = con số chứng minh, examples = tối đa 2 câu trích nguyên văn từ thư), goodExample (một thư mẫu tiếng Anh viết lại đúng chuẩn cho ví dụ tệ nhất), habits (3 thói quen cụ thể cần đổi, mỗi cái một câu ra lệnh được), progress (so với kỳ trước: cái gì tốt lên / xấu đi, hoặc nói rõ chưa có kỳ trước).`
  const lines: string[] = []
  lines.push(`Kỳ: ${fmtD(period.from)} – ${fmtD(period.to)}`)
  lines.push(metricsText('Kỳ này', i.metrics))
  lines.push(i.previous ? metricsText('Kỳ trước', i.previous) : 'Kỳ trước: không có dữ liệu')
  lines.push(`Lỗi theo rubric: ${Object.entries(i.issueCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${RUBRIC_LABELS[k as keyof typeof RUBRIC_LABELS] ?? k}): ${v}`).join(' · ') || 'không có'}`)
  lines.push(`Phân bố điểm 1→5: ${i.scoreHistogram.join(' / ')}`)
  lines.push('Thư điểm thấp nhất:')
  for (const w of i.worst) lines.push(`- #${w.fdTicketId} · điểm ${w.score} · ${w.issues.join(',')} · ${w.reason}\n  "${w.quote}"${w.rewrite ? `\n  gợi ý: ${w.rewrite}` : ''}`)
  return { system, user: lines.join('\n') }
}

export function renderReport(r: Report, period: Period, i: ReportInput): string {
  const out: string[] = []
  out.push(`# Đánh giá CS ${fmtD(period.from)} – ${fmtD(period.to)}`)
  out.push('')
  out.push(metricsText('Số liệu', i.metrics))
  out.push('')
  out.push('## Điểm yếu lớn nhất')
  r.weaknesses.forEach((w, idx) => {
    out.push(`${idx + 1}. **${w.title}** — ${w.numbers}`)
    for (const e of w.examples) out.push(`   > ${e}`)
  })
  out.push('')
  out.push('## Thư mẫu đúng chuẩn')
  out.push(r.goodExample)
  out.push('')
  out.push('## 3 thói quen cần đổi')
  r.habits.forEach(hb => out.push(`- ${hb}`))
  out.push('')
  out.push('## So với kỳ trước')
  out.push(r.progress)
  return out.join('\n')
}

export async function generateReport(period: Period, kind: 'WEEKLY' | 'MANUAL', deps: { llm: Llm; notifier?: Notifier; appUrl: string; now?: Date }): Promise<CsPerformanceReport> {
  const now = deps.now ?? new Date()
  const settings = await getCsSettings()
  const input = await buildReportInput(period)
  const { system, user } = buildReportPrompt(period, input)
  const { output } = await withCap(settings.llmDailyCallCap, () => deps.llm.complete<Report>({ system, user, model: settings.reviewModel ?? settings.model, schema: ReportSchema, schemaName: 'cs_report' }), now)
  const body = renderReport(output, period, input)
  const report = await prisma.csPerformanceReport.create({ data: { periodStart: period.from, periodEnd: period.to, kind, metricsJson: JSON.stringify(input.metrics), body } })
  if (deps.notifier) {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const top = output.weaknesses.slice(0, 3).map((w, idx) => `${idx + 1}. ${esc(w.title)} — ${esc(w.numbers)}`)
    await deps.notifier([`<b>Đánh giá CS ${fmtD(period.from)} – ${fmtD(period.to)}</b>`, ...top, esc(output.progress).slice(0, 200), `<a href="${deps.appUrl.replace(/\/$/, '')}/cs/performance">Xem đầy đủ</a>`].join('\n'))
  }
  return report
}
