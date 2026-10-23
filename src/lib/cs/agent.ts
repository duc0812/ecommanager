import { prisma } from '@/lib/db'
import type { CsAgentRun } from '@/generated/prisma/client'
import { FreshdeskBudgetExceeded, FreshdeskClient } from '@/lib/cs/freshdesk'
import { anthropicLlm, type Llm } from '@/lib/llm/anthropic'
import { syncTickets } from '@/lib/cs/sync'
import { analyzeTicket } from '@/lib/cs/analyze'
import { autoReply, notify, writeBack, type Notifier } from '@/lib/cs/actions'
import { getCsSecrets, getCsSettings } from '@/lib/cs/settings'
import { sendTelegramMessage } from '@/lib/telegram'

export type CycleDeps = { fd: FreshdeskClient; llm: Llm | null; notifier: Notifier; appUrl: string; now?: Date }

const LAST_RUN_KEY = 'last_cs_run_result'

export async function defaultDeps(): Promise<CycleDeps | null> {
  const [settings, secrets] = await Promise.all([getCsSettings(), getCsSecrets()])
  if (!secrets.freshdeskApiKey) return null
  return {
    fd: new FreshdeskClient({ domain: settings.freshdeskDomain, apiKey: secrets.freshdeskApiKey }),
    llm: secrets.anthropicApiKey ? anthropicLlm(secrets.anthropicApiKey) : null,
    notifier: text => sendTelegramMessage(text),
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? '',
  }
}

export async function runAgentCycle(deps: CycleDeps, opts: { ticketIds?: string[]; force?: boolean } = {}): Promise<CsAgentRun> {
  const now = deps.now ?? new Date()
  const run = await prisma.csAgentRun.create({ data: {} })
  const errors: string[] = []
  let analysed = 0
  let autoReplied = 0
  let ticketsSeen = 0

  try {
    const settings = await getCsSettings()
    const sync = await syncTickets(deps.fd)
    ticketsSeen = sync.seen
    if (sync.error) errors.push(`sync: ${sync.error}`)

    let targets: string[]
    if (opts.ticketIds) targets = opts.ticketIds
    else if (opts.force) targets = (await prisma.csTicket.findMany({ where: { fdStatus: { notIn: [4, 5] } }, select: { id: true } })).map(t => t.id)
    else targets = sync.changed

    if (deps.llm) {
      for (const id of targets) {
        try {
          const before = await prisma.csTicket.findUniqueOrThrow({ where: { id } })
          const analysis = await analyzeTicket(id, { llm: deps.llm, now })
          const fresh = analysis.runAt.getTime() >= run.startedAt.getTime()
          if (!fresh && !opts.ticketIds) continue
          analysed += fresh ? 1 : 0
          const ticket = await prisma.csTicket.findUniqueOrThrow({ where: { id } })
          await notify(deps.notifier, ticket, analysis, settings, deps.appUrl)
          await writeBack(deps.fd, ticket, analysis, settings, deps.appUrl)
          const gate = JSON.parse(analysis.gateJson || '{}')
          if (fresh && gate.allowed && !analysis.needsHuman && analysis.draftReply && !before.autoReplied) {
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
    data: { finishedAt: new Date(), ticketsSeen, analysed, autoReplied, fdRequests: deps.fd.requests, error: errors.length ? errors.join(' | ') : null },
  })
  const value = JSON.stringify({ ranAt: finished.finishedAt, ticketsSeen, analysed, autoReplied, fdRequests: finished.fdRequests, error: finished.error })
  await prisma.appSetting.upsert({ where: { key: LAST_RUN_KEY }, create: { key: LAST_RUN_KEY, value }, update: { value } })
  return finished
}
