import fs from 'fs'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import { runApiDelivery } from '../lib/api-delivery.mjs'
import { sharedIdsFromLedger } from '../lib/plan-to-api.mjs'
import { createDeliveryClient } from '../lib/delivery-client.mjs'
import { cachedDriveToken, createUploader } from '../lib/delivery-drive-upload.mjs'
import { COUNTDOWN_MS } from './store.mjs'
import { intakeLockKey, makeNoteClient, noteQueueState, resolveShared } from './intake.mjs'

// Queue actions (spec 7.3, 7.6, 12.3, 12.5, 13): Duyệt delivers a reviewed item with `approve` (prod DONE), Cho lên cloud and
// the 3-hour tick deliver it plainly (prod REVIEW), an expired QA-failed item is reported to /hold. Every delivery of an item
// uses the ledger of the CLI that queued it (meta.ledgerPath), so a line is never sent twice whoever sends it. Each action runs
// under the item's lock and the group's intake lock, so no other action, tick or new version touches the item meanwhile.

export const APPROVE_FAILED = 'Không duyệt được'
export const APPROVE_EVENT = 'Duyệt ở máy local'
const NEEDS_LOOK_CODES = new Set(['stale', 'not_found', 'closed', 'wrong_state'])
const TRANSIENT_CODES = new Set(['line_syncing', 'busy'])
// the server could not see an uploaded file: api-delivery forgets it and uploads again on the next run
const REUPLOAD_CODES = new Set(['drive_missing', 'wrong_folder', 'size_mismatch'])
export const TICK_BUDGET_MS = 300_000
const DELIVERABLE = ['waiting', 'rejected', 'qa_failed']
const REVIEWED = ['REVIEW', 'DONE']
const REJECTABLE = ['waiting', 'rejected', 'qa_failed', 'needs_look']
const REMOVABLE = ['waiting', 'rejected', 'qa_failed', 'needs_look']
const HOLD_TIMEOUT_MS = 60_000
const HOLD_UNCONFIGURED = 'chưa cấu hình /hold — chỉ ghi log'
const SAFE_URL = /^(https:\/\/|http:\/\/localhost[:/]|http:\/\/127\.0\.0\.1[:/])/

const errText = e => (e instanceof Error ? e.message : String(e))
const qaFailed = item => item.status === 'qa_failed' || item.qa?.verdict === 'fail'
const fail = (itemId, code, error, extra = {}) => ({ ok: false, itemId, code, error, ...extra })

/** Item lock, then the group's intake lock; a lock someone else holds → { ok:false, code:'locked' } and nothing done. */
export async function underLocks(queue, itemId, fn) {
  const item = await queue.get(itemId)
  if (!item) return fail(itemId, 'not_found', `Không có dòng ${itemId} trong hàng chờ`)
  let entered = false
  try {
    return await queue.withLock(itemId, () => queue.withLock(intakeLockKey(item.groupKey), () => {
      entered = true
      return fn()
    }))
  } catch (e) {
    if (!entered && (e?.code === 'locked' || /SQLITE_BUSY/.test(`${e?.code ?? ''} ${e?.message ?? ''}`))) {
      return fail(itemId, 'locked', 'Dòng đang được xử lý ở nơi khác — thử lại sau')
    }
    throw e
  }
}

function say(r) {
  const b = r?.body ?? {}
  if (!r) return 'không có kết quả giao'
  if (r.outcome === 'skipped') return `bỏ qua trên prod: ${r.status ?? ''} ${b.code ?? ''} ${b.error ?? ''}`.replace(/\s+/g, ' ').trim()
  if (r.outcome === 'failed' && r.status) return `prod từ chối: ${r.status} ${b.code ?? ''} ${b.error ?? ''}`.replace(/\s+/g, ' ').trim()
  return `lỗi: ${b.error ?? '?'}`
}

function problemOf(r, line, auto) {
  const code = r?.body?.code ?? null
  const message = `${line.taskKey}: ${say(r)}`
  const transient = TRANSIENT_CODES.has(code) || REUPLOAD_CODES.has(code) || (r?.status ?? 0) >= 500
  const kind = NEEDS_LOOK_CODES.has(code) || (auto && r?.status && !transient) ? 'needs_look' : 'refused'
  return { taskKey: line.taskKey, kind, code, message }
}

/** What the approve dry run of one line allows: approve it, send it without approve (already DONE), or nothing at all. */
function dryVerdict(r, line) {
  if (r?.outcome === 'alreadyApplied') return { approve: false }
  if (r?.outcome !== 'dryRun' || !r.ok) return { problem: problemOf(r, line, false) }
  const b = r.body ?? {}
  if (r.wouldApprove === true) return { approve: true }
  // a replace on a DONE line keeps DONE (the server reports wouldApprove false there by design); a resend on DONE was approved before
  if (b.status === 'DONE') return { approve: false }
  if (b.alreadyApplied) {
    return { problem: { taskKey: line.taskKey, kind: 'needs_look', code: 'changed', message: `${line.taskKey}: ${APPROVE_FAILED}: prod đã thay đổi từ lần giao trước (${b.status ?? '?'})` } }
  }
  const why = b.missing?.length ? `thiếu ${b.missing.join(', ')}` : `task sẽ ở ${b.status ?? '?'}`
  return { problem: { taskKey: line.taskKey, kind: 'refused', code: 'cannot_approve', message: `${line.taskKey}: ${APPROVE_FAILED}: ${why}` } }
}

const pick = (results, line, i) => (results[i]?.taskKey === line.taskKey ? results[i] : results.find(x => x.taskKey === line.taskKey))

export async function previewLookup(queue, item) {
  const v = (await queue.versions(item.id)).find(x => x.n === item.version)
  const byPath = new Map((v?.files ?? []).filter(f => f.path && f.preview).map(f => [path.resolve(f.path), f.preview]))
  return async p => {
    const abs = path.resolve(p)
    // A shared print's file sits in the first line's queue item, with its preview beside it.
    const pv = byPath.get(abs) ?? path.join(path.dirname(abs), 'preview', `${path.parse(abs).name}.jpg`)
    return fs.existsSync(pv) ? fs.readFileSync(pv) : null
  }
}

/**
 * Delivers every api line of an item: the lines with their own files first, then the later lines of a shared group as shortcuts
 * to the first line's Drive file (resolved from the ledger). With `approve`, each phase is a dry run first and nothing is sent
 * for real unless every line of the phase can be approved (or is already DONE).
 */
async function deliverItem(queue, item, deps, { approve, auto }) {
  const delivered = []
  const problems = []
  const ledgerPath = item.meta?.ledgerPath ?? deps.ledgerPath ?? null
  if (!ledgerPath) {
    problems.push({ taskKey: item.taskKey, kind: 'needs_look', code: 'no_ledger', message: `${item.taskKey}: dòng không có ledger giao (meta.ledgerPath)` })
    return { delivered, problems }
  }
  const log = deps.log ?? (() => {})
  const previewOf = await previewLookup(queue, item)
  const run = (lines, dryRun) => runApiDelivery({ lines, client: deps.client, uploader: deps.uploader, ledgerPath, log, previewOf, dryRun })
  const waitsOnShared = l => (l.files ?? []).some(f => f.sharedFrom && !f.shortcutOf)
  const all = item.apiLines ?? []
  if (!all.length) return { delivered, problems, error: new Error('dòng không có gì để giao (apiLines rỗng)') }

  async function phase(lines) {
    let send = lines
    if (approve) {
      const dry = await run(lines.map(l => ({ ...l, approve: true })), true)
      const plan = []
      for (const [i, l] of lines.entries()) {
        const v = dryVerdict(pick(dry.results, l, i), l)
        if (v.problem) problems.push(v.problem)
        else plan.push(v.approve ? { ...l, approve: true } : l)
      }
      if (problems.length) return
      send = plan
    }
    const real = await run(send, false)
    for (const [i, l] of send.entries()) {
      const r = pick(real.results, l, i)
      if (r?.ok && (r.outcome === 'applied' || r.outcome === 'alreadyApplied')) {
        const status = r.body?.status ?? null
        const warnings = r.warnings ?? r.body?.warnings ?? []
        // prod took the files but kept the task before REVIEW (a part or the mockup still missing there): the owner must look
        if (!approve && r.outcome === 'applied' && status && !REVIEWED.includes(status)) {
          problems.push({ taskKey: l.taskKey, kind: 'needs_look', code: 'not_review', message: `${l.taskKey}: prod nhận file nhưng giữ dòng ở ${status}${warnings.length ? ` — ${warnings.join(' | ')}` : ''}` })
        } else delivered.push({ taskKey: l.taskKey, outcome: r.outcome, status, warnings })
      } else problems.push(problemOf(r, l, auto))
    }
  }

  try {
    await phase(all.filter(l => !waitsOnShared(l)))
    const later = all.filter(waitsOnShared)
    if (!problems.length && later.length) {
      const { lines, waiting } = resolveShared(later, sharedIdsFromLedger(ledgerPath))
      for (const k of waiting) problems.push({ taskKey: k, kind: 'needs_look', code: 'shared_missing', message: `${k}: chưa thấy file dùng chung của dòng đầu trong ledger` })
      if (!waiting.length) await phase(lines)
    }
  } catch (e) {
    return { delivered, problems, error: e }
  }
  return { delivered, problems }
}

async function settle(queue, item, out, { approve, auto }) {
  const { delivered, problems, error } = out
  const results = [
    ...delivered.map(d => ({ taskKey: d.taskKey, ok: true, status: d.status, warnings: d.warnings })),
    ...problems.map(p => ({ taskKey: p.taskKey, ok: false, code: p.code, message: p.message })),
  ]
  for (const d of delivered) {
    const extra = d.warnings.length ? ` · ${d.warnings.join(' | ')}` : ''
    await queue.addEvent(item.id, 'delivery', `${d.taskKey}: đã giao${d.outcome === 'alreadyApplied' ? ' (từ lần trước)' : ''} — prod ${d.status ?? '?'}${extra}`)
  }
  for (const p of problems) await queue.addEvent(item.id, 'delivery', p.message)
  if (error) {
    const msg = errText(error)
    if (delivered.length) {
      const reason = `đã giao một phần: ${delivered.map(d => d.taskKey).join(', ')} — rồi lỗi: ${msg}`
      await queue.addEvent(item.id, 'error', reason)
      await queue.setStatus(item.id, 'needs_look', { reason })
      return fail(item.id, 'needs_look', reason, { status: 'needs_look', results })
    }
    await queue.addEvent(item.id, 'error', `Chưa giao: ${msg} — trạng thái giữ nguyên, thử lại sau`)
    return fail(item.id, 'error', msg, { status: item.status, results })
  }
  if (!problems.length) {
    const allDone = delivered.every(d => d.status === 'DONE')
    const status = allDone && (approve || delivered.every(d => d.outcome === 'alreadyApplied')) ? 'approved' : 'cloud'
    const refusedApproval = delivered.flatMap(d => d.warnings.filter(w => String(w).startsWith(APPROVE_FAILED)))
    const reason = status === 'approved' ? APPROVE_EVENT
      : approve ? (refusedApproval.join(' | ') || `${APPROVE_FAILED}: prod chưa duyệt — dòng ở Chờ duyệt`)
        : auto ? 'Quá 1 giờ — đã lên cloud (Chờ duyệt)' : 'Cho lên cloud (Chờ duyệt)'
    await queue.setStatus(item.id, status, { reason })
    return { ok: true, itemId: item.id, status, message: reason, results }
  }
  if (delivered.length || problems.some(p => p.kind === 'needs_look')) {
    const reason = delivered.length
      ? `Giao được một phần (${delivered.map(d => d.taskKey).join(', ')}) — ${problems.map(p => p.message).join(' | ')}`
      : `Prod đã thay đổi — cần xem: ${problems.filter(p => p.kind === 'needs_look').map(p => p.message).join(' | ')}`
    await queue.setStatus(item.id, 'needs_look', { reason })
    return fail(item.id, 'needs_look', reason, { status: 'needs_look', results })
  }
  const code = problems.every(p => p.code === 'cannot_approve') ? 'cannot_approve' : 'refused'
  return fail(item.id, code, problems.map(p => p.message).join(' | '), { status: item.status, results })
}

const versionError = (itemId, item, version) =>
  version != null && item.version !== version
    ? fail(itemId, 'version_changed', `Dòng đã có bản mới v${item.version} (trang đang xem v${version}) — xem lại rồi bấm lại`, { status: item.status, version: item.version })
    : null

async function deliverAction(queue, itemId, deps, opts) {
  const r = await deliverLocked(queue, itemId, deps, opts)
  if (r?.status === 'needs_look') await noteQueueState(queue, itemId, deps.noter ?? null, deps.log)
  return r
}

async function deliverLocked(queue, itemId, deps, { approve, auto = false, force = false, at = null, version = null }) {
  return underLocks(queue, itemId, async () => {
    const item = await queue.get(itemId)
    if (at != null) {
      if (item.status !== 'waiting' || qaFailed(item) || item.version !== version || Date.parse(item.enteredAt) + COUNTDOWN_MS > at) return { skip: true }
    } else {
      const changed = versionError(itemId, item, version)
      if (changed) return changed
      if (!DELIVERABLE.includes(item.status)) return fail(itemId, 'not_deliverable', `Dòng đang ${item.status} — không giao được`, { status: item.status })
      if (qaFailed(item) && !force) return fail(itemId, 'qa_failed', 'Dòng có lỗi QA — cần xác nhận lần hai (force) để giao', { status: item.status })
    }
    if (qaFailed(item)) await queue.addEvent(itemId, 'force', `${approve ? 'Duyệt' : 'Cho lên cloud'} dù có lỗi QA (v${item.version})`)
    const out = await deliverItem(queue, item, deps, { approve, auto })
    return settle(queue, item, out, { approve, auto })
  })
}

/**
 * Duyệt: dry run with approve, then the real delivery with approve (prod DONE). `version` is the version the owner looked at
 * (required; a newer one → version_changed). `force` is needed for an item whose QA failed.
 * @param {any} queue @param {string} itemId @param {any} deps @param {{ force?: boolean, version?: number }} [opts]
 */
export async function approveItem(queue, itemId, deps, { force = false, version } = {}) {
  if (!Number.isInteger(version)) return fail(itemId, 'version_required', 'Duyệt cần số bản đang xem (version)')
  return deliverAction(queue, itemId, deps, { approve: true, force, version })
}

/**
 * Cho lên cloud ngay: plain delivery (prod REVIEW), as when the 3 hours are over. A given `version` must still be current.
 * @param {any} queue @param {string} itemId @param {any} deps @param {{ force?: boolean, version?: number|null }} [opts]
 */
export async function sendToCloud(queue, itemId, deps, { force = false, version = null } = {}) {
  return deliverAction(queue, itemId, deps, { approve: false, force, version })
}

/**
 * Trả lại: the item stays in the queue as rejected (no countdown) until a new version or Cho lên cloud. A given `version` must still be current.
 * `noter` (the short-budget note client) tells prod the line no longer counts down.
 * @param {any} queue @param {string} itemId @param {string} reason @param {{ version?: number|null, noter?: any, log?: (m: string) => void }} [opts]
 */
export async function rejectItem(queue, itemId, reason, { version = null, noter = null, log = console.log } = {}) {
  const why = typeof reason === 'string' ? reason.trim() : ''
  if (!why) return fail(itemId, 'bad_request', 'Cần lý do trả lại')
  const r = await underLocks(queue, itemId, async () => {
    const item = await queue.get(itemId)
    const changed = versionError(itemId, item, version)
    if (changed) return changed
    if (!REJECTABLE.includes(item.status)) return fail(itemId, 'not_active', `Dòng đang ${item.status} — không trả lại được`, { status: item.status })
    await queue.setStatus(itemId, 'rejected', { reason: why })
    return { ok: true, itemId, status: 'rejected', message: why }
  })
  if (r?.ok) await noteQueueState(queue, itemId, noter, log)
  return r
}

/**
 * Bỏ khỏi hàng chờ: nothing is sent; a fixing item must finish (or fail) first. A given `version` must still be current.
 * @param {any} queue @param {string} itemId @param {{ version?: number|null }} [opts]
 */
export async function removeItem(queue, itemId, { version = null } = {}) {
  return underLocks(queue, itemId, async () => {
    const item = await queue.get(itemId)
    const changed = versionError(itemId, item, version)
    if (changed) return changed
    if (item.status === 'fixing') return fail(itemId, 'fixing', 'Agent đang sửa dòng này — chờ xong rồi bỏ', { status: item.status })
    if (!REMOVABLE.includes(item.status)) return fail(itemId, 'not_active', `Dòng đang ${item.status} — không còn trong hàng chờ`, { status: item.status })
    await queue.setStatus(itemId, 'removed', { reason: 'Bỏ khỏi hàng chờ' })
    return { ok: true, itemId, status: 'removed', message: 'Bỏ khỏi hàng chờ' }
  })
}

const holdReason = item => `Lỗi QA ở hàng chờ local, quá 1 giờ không ai xử lý: ${(item.qa?.items ?? []).join('; ') || 'không rõ lỗi'}`

async function holdExpired(queue, itemId, deps, at) {
  return underLocks(queue, itemId, async () => {
    const item = await queue.get(itemId)
    if (!['qa_failed', 'waiting'].includes(item.status) || !qaFailed(item) || Date.parse(item.enteredAt) + COUNTDOWN_MS > at) return { skip: true }
    const keys = (await queue.memberKeys(itemId)).length ? await queue.memberKeys(itemId) : [item.taskKey]
    const reason = holdReason(item)
    const log = deps.log ?? (() => {})
    const mark = k => `v${item.version}:${k}`
    const done = new Set((await queue.events(itemId)).filter(e => e.type === 'hold_reported').map(e => e.message))
    let reported = 0
    for (const k of keys) {
      if (done.has(mark(k))) { reported++; continue }
      try {
        const r = deps.hold ? await deps.hold(k, reason) : (log(`giữ lại ${k}: ${reason} (${HOLD_UNCONFIGURED})`), { reported: false })
        if (r?.reported !== false) {
          reported++
          await queue.addEvent(itemId, 'hold_reported', mark(k))
        }
      } catch (e) {
        await queue.addEvent(itemId, 'hold_failed', `${k}: không báo được /hold (${errText(e)}) — lần tick sau báo lại`)
        return fail(itemId, 'hold_failed', errText(e), { status: item.status })
      }
    }
    const why = reported ? reason : `${reason} (${HOLD_UNCONFIGURED})`
    await queue.setStatus(itemId, 'held', { reason: why })
    return { ok: true, itemId, status: 'held', message: why }
  })
}

/**
 * One tick: every expired waiting item goes to the cloud (REVIEW), every expired QA-failed item is reported to /hold and leaves
 * the queue. An item changed or taken meanwhile is skipped; a locked one is reported with code 'locked' and tried next tick.
 * @returns {Promise<{ actions: { itemId: string, taskKey: string, action: 'cloud'|'hold', ok: boolean, status?: string, code?: string, error?: string, message?: string }[] }>}
 */
export async function tickQueue(queue, deps, now = new Date()) {
  const at = new Date(now).getTime()
  const actions = []
  for (const item of await queue.expired(at)) {
    // a QA-failed line never goes to the cloud by itself (spec 13): it is reported to /hold instead
    const action = qaFailed(item) ? 'hold' : 'cloud'
    let r
    try {
      r = action === 'hold' ? await holdExpired(queue, item.id, deps, at) : await deliverAction(queue, item.id, deps, { approve: false, auto: true, at, version: item.version })
    } catch (e) {
      r = fail(item.id, 'error', errText(e))
    }
    if (r?.skip) continue
    actions.push({ itemId: item.id, taskKey: item.taskKey, action, ...r })
  }
  return { actions }
}

/**
 * The /hold report of auto render (`post_hold` in tools/auto-render-hourly/auto_render.py): POST <ECOM_URL>/api/design-agent/runner/hold
 * { taskKey, reason } with the design agent token, 60 s, no redirects, non-2xx → error. Without URL or token it only logs.
 */
export function makeHold({ baseUrl, token, fetchImpl = fetch, log = console.log }) {
  const root = (baseUrl ?? '').replace(/\/+$/, '')
  return async (taskKey, reason) => {
    if (!root || !token) {
      log(`giữ lại ${taskKey}: ${reason} (${HOLD_UNCONFIGURED})`)
      return { reported: false, jobId: null }
    }
    if (!SAFE_URL.test(`${root}/`)) throw new Error('ECOM_URL phải là https://… (hoặc http://localhost)')
    let res
    try {
      res = await fetchImpl(`${root}/api/design-agent/runner/hold`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskKey, reason }),
        redirect: 'manual',
        signal: AbortSignal.timeout(HOLD_TIMEOUT_MS),
      })
    } catch (e) {
      throw new Error(`/hold không gọi được (${e?.name ?? 'Error'})`)
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`/hold trả ${res.status}`)
    const body = await res.json().catch(() => null)
    log(`giữ lại ${taskKey}: ${reason} — đã báo /hold${body?.jobId ? ` (job ${body.jobId})` : ' (chỉ ghi chú)'}`)
    return { reported: true, jobId: body?.jobId ?? null }
  }
}

function readEnvFile(file) {
  const out = {}
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    let v = line.slice(i + 1).trim()
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1)
    out[line.slice(0, i).trim()] = v
  }
  return out
}

/** Copies the listed keys of each env file into `env`, never over a variable already set; a missing file is skipped. */
export function loadEnvFiles(specs, env = process.env) {
  for (const { file, keys } of specs) {
    if (!fs.existsSync(file)) continue
    const vars = readEnvFile(file)
    for (const k of keys) if (env[k] === undefined && vars[k] !== undefined) env[k] = vars[k]
  }
  return env
}

/** prod.env of the artwork worker (URL + worker token), auto render's config.env (design agent token). The approve token: loadApproveToken. */
export function queueEnvFiles(env = process.env) {
  const home = env.USERPROFILE || os.homedir()
  return [
    { file: path.join(home, '.artwork-worker', 'prod.env'), keys: ['ECOM_URL', 'DESIGN_WORKER_TOKEN'] },
    { file: path.join(env.AUTO_RENDER_HOME || path.join(home, '.auto-render'), 'config.env'), keys: ['ECOM_URL', 'DESIGN_AGENT_TOKEN', 'MAIN_CHECKOUT'] },
  ]
}

const psQuote = s => `'${String(s).replace(/'/g, "''")}'`

/** Plain text of a DPAPI (user scope) file written by `ConvertFrom-SecureString`, through PowerShell's ConvertTo-SecureString. */
export function dpapiDecrypt(file) {
  const script = `$s = (Get-Content -Raw -LiteralPath ${psQuote(file)}).Trim() | ConvertTo-SecureString; `
    + '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * DELIVERY_APPROVE_TOKEN from %USERPROFILE%\.review-queue\approve.dpapi (DPAPI, decrypted once with `decrypt`); only when that file is
 * absent, from approve.env with a warning. A variable already set wins. The token is never logged.
 * @param {Record<string, string|undefined>} [env] @param {{ decrypt?: (file: string) => string, log?: (m: string) => void }} [opts]
 * @returns {'env'|'dpapi'|'plain'|'none'|'error'} where the token came from
 */
export function loadApproveToken(env = process.env, { decrypt = dpapiDecrypt, log = console.log } = {}) {
  if (env.DELIVERY_APPROVE_TOKEN) return 'env'
  const dir = path.join(env.USERPROFILE || os.homedir(), '.review-queue')
  const sealed = path.join(dir, 'approve.dpapi')
  if (fs.existsSync(sealed)) {
    let text
    try {
      text = String(decrypt(sealed) ?? '')
    } catch (e) {
      log(`LỖI: không giải mã được ${sealed} (${e instanceof Error ? e.message.split(/\r?\n/)[0] : 'lỗi'}) — Duyệt sẽ không có token duyệt`)
      return 'error'
    }
    const m = /^\s*DELIVERY_APPROVE_TOKEN\s*=\s*(.*?)\s*$/m.exec(text)
    const token = (m ? m[1] : text).trim().replace(/^(["'])(.*)\1$/, '$2')
    if (!token) {
      log(`LỖI: ${sealed} giải mã ra rỗng — Duyệt sẽ không có token duyệt`)
      return 'error'
    }
    env.DELIVERY_APPROVE_TOKEN = token
    return 'dpapi'
  }
  const plain = path.join(dir, 'approve.env')
  if (!fs.existsSync(plain)) return 'none'
  loadEnvFiles([{ file: plain, keys: ['DELIVERY_APPROVE_TOKEN'] }], env)
  if (!env.DELIVERY_APPROVE_TOKEN) return 'none'
  log(`CẢNH BÁO: token duyệt đọc từ ${plain} (chưa mã hoá) — tạo approve.dpapi bằng scripts/review-queue/mint-approve-token.mjs rồi xoá approve.env`)
  return 'plain'
}

/** The env files of queueEnvFiles, then the approve token (loadApproveToken). Server and tick call it once at start. */
export function loadQueueEnv(env = process.env, opts = {}) {
  loadEnvFiles(queueEnvFiles(env), env)
  loadApproveToken(env, opts)
  return env
}

/**
 * Real deps from the environment; the client and uploader are built on first use, so a tick with nothing to send needs no token.
 * `budgetMs` (optional) caps the client's retries (the tick uses TICK_BUDGET_MS so one run never waits 30 minutes).
 * @param {{ env?: Record<string, string|undefined>, log?: (m: string) => void, fetchImpl?: typeof fetch, budgetMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} [opts]
 */
export function makeLiveDeps({ env = process.env, log = console.log, fetchImpl = fetch, budgetMs, sleep, now } = {}) {
  const url = (env.ECOM_URL ?? '').replace(/\/+$/, '')
  let client = null
  let uploader = null
  let noter
  const deps = {
    log,
    get noter() {
      if (noter === undefined) {
        noter = url && SAFE_URL.test(`${url}/`) && env.DESIGN_WORKER_TOKEN ? makeNoteClient({ baseUrl: url, token: env.DESIGN_WORKER_TOKEN, fetchImpl }) : null
      }
      return noter
    },
    get client() {
      if (!client) {
        if (!url || !SAFE_URL.test(`${url}/`)) throw new Error('ECOM_URL chưa đặt hoặc không phải https://… (hoặc http://localhost)')
        const timing = Object.fromEntries(Object.entries({ budgetMs, sleep, now }).filter(([, v]) => v !== undefined))
        client = createDeliveryClient({ baseUrl: url, token: env.DESIGN_WORKER_TOKEN, approveToken: env.DELIVERY_APPROVE_TOKEN || null, fetchImpl, ...timing })
      }
      return client
    },
    get uploader() {
      return (uploader ??= createUploader({ accessToken: cachedDriveToken(deps.client), fetchImpl }))
    },
    hold: makeHold({ baseUrl: url, token: env.DESIGN_AGENT_TOKEN, fetchImpl, log }),
  }
  return deps
}
