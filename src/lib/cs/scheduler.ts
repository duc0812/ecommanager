import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { defaultDeps, runAgentCycle } from '@/lib/cs/agent'
import { dailyDigest } from '@/lib/cs/actions'
import { getCsSettings } from '@/lib/cs/settings'
import { generateReport } from '@/lib/cs/report'
import { weekBounds } from '@/lib/cs/performance'
import { sendTelegramMessage } from '@/lib/telegram'

const TZ = 'Asia/Ho_Chi_Minh'

export async function runScheduledCycle() {
  const settings = await getCsSettings()
  if (!settings.pollEnabled) return
  const deps = await defaultDeps()
  if (!deps) { console.log('[cs] no Freshdesk key; skipping'); return }
  const run = await runAgentCycle(deps)
  if (run.error) console.warn(`[cs] cycle finished with errors: ${run.error}`)
  else if (run.analysed || run.autoReplied) console.log(`[cs] seen ${run.ticketsSeen}, analysed ${run.analysed}, auto-replied ${run.autoReplied}, fd requests ${run.fdRequests}`)
}

export async function runWeeklyReport() {
  const settings = await getCsSettings()
  if (!settings.weeklyReport) return
  const deps = await defaultDeps()
  if (!deps?.llm) { console.log('[cs] weekly report skipped: no llm'); return }
  const period = weekBounds(new Date(), -1)
  const r = await generateReport(period, 'WEEKLY', { llm: deps.llm, notifier: deps.notifier, appUrl: deps.appUrl })
  console.log(`[cs] weekly report ${r.id} for ${period.from.toISOString().slice(0, 10)}`)
}

export function initCsScheduler() {
  if (!initOnce('cs-scheduler')) return
  cron.schedule('*/2 * * * *', () => {
    runExclusive('cs-agent', runScheduledCycle)
      .then(r => { if (r.skipped) console.warn('[cs] previous cycle still active; skipped') })
      .catch(err => console.error('[cs] unhandled:', err))
  }, { timezone: TZ })
  cron.schedule('0 8 * * 1', () => {
    runExclusive('cs-weekly-report', runWeeklyReport).catch(err => console.error('[cs] weekly report failed:', err))
  }, { timezone: TZ })
  cron.schedule('0 9 * * *', () => {
    runExclusive('cs-digest', () => dailyDigest(text => sendTelegramMessage(text), process.env.NEXT_PUBLIC_APP_URL ?? ''))
      .catch(err => console.error('[cs] digest failed:', err))
  }, { timezone: TZ })
  console.log('[cs] Initialized — Freshdesk sync every 2 min, digest 09:00, weekly CS report Monday 08:00 Asia/Ho_Chi_Minh')
}
