import { prisma } from '@/lib/db'
import type { CsAgentRun } from '@/generated/prisma/client'
import { FreshdeskBudgetExceeded, FreshdeskClient } from '@/lib/cs/freshdesk'
import { llmFor, pickLlmKey, type Llm } from '@/lib/llm/anthropic'
import { syncTickets } from '@/lib/cs/sync'
import { analyzeTicket } from '@/lib/cs/analyze'
import { analysisHash, autoReply, notify, writeBack, type Notifier } from '@/lib/cs/actions'
import { getCsSecrets, getCsSettings } from '@/lib/cs/settings'
import { sendTelegramMessage } from '@/lib/telegram'

export type CycleDeps = { fd: FreshdeskClient; llm: Llm | null; notifier: Notifier; appUrl: string; now?: Date }

const LAST_RUN_KEY = 'last_cs_run_result'
const RETRY_PER_CYCLE = 10

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
      const retry = (await prisma.csTicket.findMany({ where: { id: { in: open, notIn: changed }, lastAnalysisAt: null }, orderBy: { lastCustomerAt: 'asc' }, take: RETRY_PER_CYCLE, select: { id: true } })).map(t => t.id)
      targets = [...changed, ...retry]
    }

    if (deps.llm) {
      for (const id of targets) {
        try {
          const before = await prisma.csTicket.findUniqueOrThrow({ where: { id } })
          const analysis = await analyzeTicket(id, { llm: deps.llm, now, force: opts.force })
          const fresh = analysis.runAt.getTime() >= run.startedAt.getTime()
          if (!fresh && !opts.ticketIds) continue
          analysed += fresh ? 1 : 0
          const ticket = await prisma.csTicket.findUniqueOrThrow({ where: { id } })
          const shouldNotify = settings.notifyLevels.includes(analysis.urgency) && ticket.lastNoteHash !== analysisHash(analysis, ticket.orderNumber)
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
          errors.push(`ticket ${id}: ${err?.message ?? String(err)}`)
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
