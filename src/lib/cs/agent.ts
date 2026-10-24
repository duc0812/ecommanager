import { prisma } from '@/lib/db'
import type { CsAgentRun } from '@/generated/prisma/client'
import { FreshdeskBudgetExceeded, FreshdeskClient } from '@/lib/cs/freshdesk'
import { llmFor, pickLlmKey, type Llm } from '@/lib/llm/anthropic'
import { syncTickets } from '@/lib/cs/sync'
import { analyzeTicket } from '@/lib/cs/analyze'
import { analysisHash, autoReply, notify, writeBack, type Notifier } from '@/lib/cs/actions'
import { getCsSecrets, getCsSettings } from '@/lib/cs/settings'
import { investigateTicket, pendingInvestigations } from '@/lib/cs/root-cause'
import { LlmCapReached, withCap } from '@/lib/llm/cap'
import { LlmError } from '@/lib/llm/types'
import { pendingReviews, reviewTicket } from '@/lib/cs/review'
import { sendTelegramMessage } from '@/lib/telegram'

export type CycleDeps = { fd: FreshdeskClient; llm: Llm | null; notifier: Notifier; appUrl: string; now?: Date }

const LAST_RUN_KEY = 'last_cs_run_result'
const RETRY_PER_CYCLE = 10
const INVESTIGATIONS_PER_CYCLE = 5
const REVIEWS_PER_CYCLE = 5

export async function defaultDeps(): Promise<CycleDeps | null> {
  const [settings, secrets] = await Promise.all([getCsSettings(), getCsSecrets()])
  if (!secrets.freshdeskApiKey) return null
  return {
    fd: new FreshdeskClient({ domain: settings.freshdeskDomain, apiKey: secrets.freshdeskApiKey }),
    llm: (() => { const key = pickLlmKey(settings.llmProvider, secrets); return key ? llmFor(settings.llmProvider, settings.model, key) : null })(),
    notifier: text => sendTelegramMessage(text),
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? '',
  }
}

export async function runAgentCycle(deps: CycleDeps, opts: { ticketIds?: string[]; force?: boolean; autoReply?: boolean } = {}): Promise<CsAgentRun> {
  const now = deps.now ?? new Date()
  const run = await prisma.csAgentRun.create({ data: {} })
  const errors: string[] = []
  let partialNote: string | null = null
  let analysed = 0
  let autoReplied = 0
  let ticketsSeen = 0

  try {
    const settings = await getCsSettings()
    const sync = await syncTickets(deps.fd)
    ticketsSeen = sync.seen
    if (sync.error) errors.push(`sync: ${sync.error}`)

    if (sync.partial) partialNote = 'còn ticket chưa lấy hết, lượt sau tiếp tục'
    const open = (await prisma.csTicket.findMany({ where: { fdStatus: { notIn: [4, 5] }, resolvedInTool: false }, select: { id: true } })).map(t => t.id)
    let targets: string[]
    if (opts.ticketIds) targets = opts.ticketIds
    else if (opts.force) targets = open
    else {
      const changed = sync.changed.filter(id => open.includes(id))
      const pendingWriteBack = (await prisma.csTicket.findMany({ where: { id: { in: open, notIn: changed }, lastAnalysisAt: { not: null }, lastNoteHash: null }, orderBy: { lastAnalysisAt: 'asc' }, take: RETRY_PER_CYCLE, select: { id: true } })).map(t => t.id)
      const retry = (await prisma.csTicket.findMany({ where: { id: { in: open, notIn: [...changed, ...pendingWriteBack] }, lastAnalysisAt: null }, orderBy: { lastCustomerAt: 'asc' }, take: RETRY_PER_CYCLE, select: { id: true } })).map(t => t.id)
      targets = [...changed, ...pendingWriteBack, ...retry]
    }

    if (deps.llm) {
      for (const id of targets) {
        try {
          const before = await prisma.csTicket.findUniqueOrThrow({ where: { id } })
          const analysis = await analyzeTicket(id, { llm: deps.llm, now, force: opts.force })
          const fresh = analysis.runAt.getTime() >= run.startedAt.getTime()
          const ticket = await prisma.csTicket.findUniqueOrThrow({ where: { id } })
          const writeBackPending = ticket.lastNoteHash !== analysisHash(analysis, ticket.orderNumber)
          if (!fresh && !writeBackPending && !opts.ticketIds) continue
          analysed += fresh ? 1 : 0
          const shouldNotify = settings.notifyLevels.includes(analysis.urgency) && writeBackPending
          await writeBack(deps.fd, ticket, analysis, settings, deps.appUrl)
          if (shouldNotify) {
            try { await notify(deps.notifier, { ...ticket, lastNoteHash: null }, analysis, settings, deps.appUrl) }
            catch (err: any) { errors.push(`notify ${id}: ${err?.message ?? String(err)}`) }
          }
          const gate = JSON.parse(analysis.gateJson || '{}')
          if (opts.autoReply !== false && fresh && gate.allowed && !analysis.needsHuman && analysis.draftReply && !before.autoReplied) {
            await autoReply(deps.fd, ticket, analysis, now)
            autoReplied += 1
          }
        } catch (err: any) {
          if (err instanceof FreshdeskBudgetExceeded) { errors.push(err.message); break }
          if (err instanceof LlmCapReached) { partialNote = `đã chạm trần ${settings.llmDailyCallCap} lần gọi model hôm nay`; console.warn('[cs] llm daily cap reached'); break }
          errors.push(`ticket ${id}: ${err?.message ?? String(err)}`)
        }
      }
    }
    if (deps.llm && !opts.ticketIds && !partialNote) {
      for (const id of await pendingInvestigations(INVESTIGATIONS_PER_CYCLE)) {
        try {
          await investigateTicket(id, { llm: deps.llm!, now })
        } catch (err: any) {
          if (err instanceof LlmCapReached) { partialNote = `đã chạm trần ${settings.llmDailyCallCap} lần gọi model hôm nay`; console.warn('[cs] llm daily cap reached'); break }
          errors.push(`root cause ${id}: ${err?.message ?? String(err)}`)
          if (err instanceof LlmError) await prisma.csAnalysis.updateMany({ where: { ticketId: id, rootCauseAt: null }, data: { rootCauseAt: now, rootCauseStage: 'UNKNOWN', rootCauseConfidence: 'LOW', issueType: 'OTHER', rootCauseEvidence: `Lỗi model: ${err.message.slice(0, 200)}` } })
        }
      }
      if (settings.reviewEnabled && !partialNote) {
        for (const id of await pendingReviews(REVIEWS_PER_CYCLE, now)) {
          try {
            await reviewTicket(id, { llm: deps.llm, now })
          } catch (err: any) {
            if (err instanceof LlmCapReached) { partialNote = `đã chạm trần ${settings.llmDailyCallCap} lần gọi model hôm nay`; console.warn('[cs] llm daily cap reached'); break }
            errors.push(`review ${id}: ${err?.message ?? String(err)}`)
            if (err instanceof LlmError) await prisma.csTicket.update({ where: { id }, data: { reviewedAt: now } })
          }
        }
      }
    }
  } catch (err: any) {
    errors.push(err?.message ?? String(err))
  }

  const finished = await prisma.csAgentRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), ticketsSeen, analysed, autoReplied, fdRequests: deps.fd.requests, error: errors.length ? errors.join(' | ') : null, partial: partialNote },
  })
  const value = JSON.stringify({ ranAt: finished.finishedAt, ticketsSeen, analysed, autoReplied, fdRequests: finished.fdRequests, error: finished.error, partial: finished.partial })
  await prisma.appSetting.upsert({ where: { key: LAST_RUN_KEY }, create: { key: LAST_RUN_KEY, value }, update: { value } })
  return finished
}
