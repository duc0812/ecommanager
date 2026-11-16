import path from 'path'
import { fileURLToPath } from 'url'
import { openQueue } from './store.mjs'
import { DEFAULT_QUEUE_ROOT } from './intake.mjs'
import { TICK_BUDGET_MS, loadQueueEnv, makeLiveDeps, tickQueue } from './actions.mjs'
import { STALE_JOB_MS, recoverFixJobs } from './fix-job.mjs'

// The 3-hour tick (spec 7.6), run every 10 minutes by the Windows task "EcomManager Review Queue Tick":
//   node scripts/review-queue/tick.mjs
// Env comes from %USERPROFILE%\.artwork-worker\prod.env, auto render's config.env and the approve token (approve.dpapi, else
// approve.env); a variable already set wins. Exit 0 unless the queue cannot be opened (a failed item is retried on the next tick).
// A fix job still `running` 70 minutes after its start (its server is gone) is recovered like at server start.

function describe(a) {
  const what = a.action === 'hold' ? 'báo /hold' : 'lên cloud'
  if (a.ok) return `${a.taskKey} (${a.itemId}): ${what} → ${a.status}${a.message ? ` — ${a.message}` : ''}`
  if (a.code === 'locked') return `${a.taskKey} (${a.itemId}): đang bận, để lần sau`
  return `${a.taskKey} (${a.itemId}): ${what} chưa được [${a.code}${a.status ? `, ${a.status}` : ''}] ${a.error ?? ''}`.trim()
}

export async function main({ env = process.env, log = console.log, now = () => new Date(), deps = null, decrypt, recover = {} } = /** @type {any} */ ({})) {
  loadQueueEnv(env, { log, ...(decrypt ? { decrypt } : {}) })
  const root = env.REVIEW_QUEUE_ROOT || DEFAULT_QUEUE_ROOT
  let queue
  try {
    queue = await openQueue({ root })
  } catch (e) {
    log(`LỖI: không mở được hàng chờ ${root}: ${e instanceof Error ? e.message : e}`)
    return 1
  }
  try {
    const at = now()
    const live = deps ?? makeLiveDeps({ env, log, budgetMs: TICK_BUDGET_MS })
    const stale = await recoverFixJobs(queue, { log, now, staleAfterMs: STALE_JOB_MS, noter: live.noter ?? null, ...recover })
    if (stale.length) log(`Đã gỡ ${stale.length} job agent chạy quá ${Math.round(STALE_JOB_MS / 60_000)} phút`)
    const { actions } = await tickQueue(queue, live, at)
    for (const a of actions) log(describe(a))
    log(`tick ${at.toISOString()} · ${actions.length} việc · lên cloud ${actions.filter(a => a.ok && a.action === 'cloud').length} · báo /hold ${actions.filter(a => a.ok && a.action === 'hold').length} · chưa xong ${actions.filter(a => !a.ok).length}`)
    return 0
  } catch (e) {
    log(`LỖI tick: ${e instanceof Error ? e.message : e}`)
    return 0
  } finally {
    await queue.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code))
}
