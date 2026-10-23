import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { defaultDeps, runAgentCycle } from '@/lib/cs/agent'
import { dailyDigest } from '@/lib/cs/actions'
import { getCsSettings } from '@/lib/cs/settings'
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

export function initCsScheduler() {
  if (!initOnce('cs-scheduler')) return
  cron.schedule('*/2 * * * *', () => {
    runExclusive('cs-agent', runScheduledCycle)
      .then(r => { if (r.skipped) console.warn('[cs] previous cycle still active; skipped') })
      .catch(err => console.error('[cs] unhandled:', err))
  }, { timezone: TZ })
  cron.schedule('0 9 * * *', () => {
    runExclusive('cs-digest', () => dailyDigest(text => sendTelegramMessage(text), process.env.NEXT_PUBLIC_APP_URL ?? ''))
      .catch(err => console.error('[cs] digest failed:', err))
  }, { timezone: TZ })
  console.log('[cs] Initialized — Freshdesk sync every 2 min, digest 09:00 Asia/Ho_Chi_Minh')
}
