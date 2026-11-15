import path from 'path'
import { readLedger, runApiDelivery } from './api-delivery.mjs'
import { DeliveryGaveUp, DeliveryStopped } from './delivery-client.mjs'

// Turns the plan of push-local-renders / push-shared-prints (buildPlan lines) into Artwork Delivery API lines, and runs them.
// A part the local push already put on Drive goes with that id (knownDriveFileId) so no second copy appears; the local path
// rides along for the re-upload when the server refuses the id. A no-custom print several lines share goes as a shortcut to
// the one file (owner rule: one link, never a copy per order).

export const API_ACTIONS = ['push', 'replace', 'revert']
export const NO_LOCAL_COPY = 'không có bản local để upload'

const fileKey = f => `${f.kind ?? 'PRINT'}/${f.printArea}`

/**
 * @param {{ lines: any[] }} plan
 * @param {{ storageRoot: string, sharedIds?: ((taskKey: string, fileKey: string) => string|null) | null }} opts
 * @returns {{ lines: any[], skipped: { taskKey: string, reason: string, waitingFor?: string }[] }}
 */
export function planLinesToApi(plan, { storageRoot, sharedIds = null }) {
  const lines = []
  const skipped = []
  // a Drive file several lines reuse: the first line sent commits it, every later one gets a shortcut once that is on prod
  const owners = new Map()
  for (const l of plan.lines ?? []) {
    if (!API_ACTIONS.includes(l.action)) { skipped.push({ taskKey: l.taskKey, reason: l.skipReason ?? `action ${l.action}` }); continue }
    const files = []
    const claims = []
    let stop = null
    for (const f of l.action === 'revert' ? [] : l.files ?? []) {
      if (f.keep) continue
      const base = { kind: f.kind ?? 'PRINT', printArea: f.printArea }
      const meta = { fileName: f.fileName, mimeType: f.mimeType, widthPx: f.widthPx, heightPx: f.heightPx }
      const local = f.storagePath ? { path: path.resolve(storageRoot, f.storagePath) } : {}
      const isPrint = base.kind === 'PRINT'
      const ownUpload = () => {
        if (f.storagePath) { files.push({ ...base, ...local, ...meta }); return true }
        stop = { reason: `mockup ${f.printArea} dùng chung mà ${NO_LOCAL_COPY} (lối tắt chỉ dùng cho file in)` }
        return false
      }
      const shortcutTo = (from, key, what) => {
        const id = sharedIds?.(from, key) ?? null
        if (id) { files.push({ ...base, ...meta, shortcutOf: id, size: Number(f.size) }); return true }
        stop = { reason: `dùng chung ${what} với ${from} — chờ ${from} ghi xong rồi chạy lại`, waitingFor: from }
        return false
      }
      if (f.shared && f.driveFileId) {
        if (isPrint) { files.push({ ...base, ...meta, shortcutOf: f.driveFileId, size: Number(f.size) }); continue }
        if (ownUpload()) continue
        break
      }
      if (f.sharedFrom && !f.driveFileId) {
        if (isPrint ? shortcutTo(f.sharedFrom, fileKey(f), 'file') : ownUpload()) continue
        break
      }
      if (f.transfer === 'reuse' && f.driveFileId) {
        const owner = owners.get(f.driveFileId)
        if (owner && owner.taskKey !== l.taskKey) {
          if (isPrint ? shortcutTo(owner.taskKey, owner.key, `file Drive ${f.driveFileId}`) : ownUpload()) continue
          break
        }
        files.push({ ...base, ...local, ...meta, knownDriveFileId: f.driveFileId, size: Number(f.size) })
        claims.push([f.driveFileId, { taskKey: l.taskKey, key: fileKey(f) }])
        continue
      }
      if (!f.storagePath) { stop = { reason: NO_LOCAL_COPY }; break }
      files.push({ ...base, ...local, ...meta })
    }
    if (stop) { skipped.push({ taskKey: l.taskKey, ...stop }); continue }
    for (const [id, owner] of claims) if (!owners.has(id)) owners.set(id, owner)
    const retire = l.action === 'replace' ? (l.replaces ?? []).map(r => r.id) : []
    const action = l.action === 'replace' && !files.length ? 'retire' : l.action
    const out = { taskKey: l.taskKey, action, files, retire }
    const expectedStatus = l.expectedStatus ?? l.prodStatus
    if (expectedStatus != null) out.expectedStatus = expectedStatus
    const planIds = (l.action === 'replace' || l.action === 'revert') ? (l.replaces ?? []).map(r => r.id) : []
    if (planIds.length) out.planIds = planIds
    if (l.action === 'revert') {
      out.revertReadiness = l.readiness
      out.eventMessage = l.eventMessage ?? l.reason
    } else if (l.eventMessage !== undefined && l.eventMessage !== null) out.eventMessage = l.eventMessage
    if (l.retireSources) out.retireSources = l.retireSources
    if (l.allowFinished !== undefined) out.allowFinished = l.allowFinished
    lines.push(out)
  }
  return { lines, skipped }
}

/** The Drive id a line uploaded for a part, from its newest applied delivery in the API ledger. */
export function sharedIdsFromLedger(ledgerPath) {
  const ledger = readLedger(ledgerPath)
  const entries = Object.values(ledger.lines ?? {}).filter(e => e?.applied).sort((a, b) => String(b.applied).localeCompare(String(a.applied)))
  return (taskKey, key) => entries.find(e => e.taskKey === taskKey && e.files?.[key]?.driveFileId)?.files[key].driveFileId ?? null
}

function describe(r) {
  const b = r.body ?? {}
  const extra = `${b.missing?.length ? ` · thiếu ${b.missing.join(', ')}` : ''}${b.warnings?.length ? ` · cảnh báo: ${b.warnings.join(' | ')}` : ''}`
  if (r.outcome === 'applied') return `đã ghi${b.status ? ` (${b.status})` : ''}${b.alreadyApplied ? ', server báo đã có' : ''}${extra}`
  if (r.outcome === 'alreadyApplied') return 'đã ghi từ lần chạy trước'
  if (r.outcome === 'dryRun') return `dry run OK, sẽ là ${b.status ?? '?'}${extra}`
  if (r.outcome === 'skipped') return `bỏ qua trên prod: ${r.status ?? ''} ${b.code ?? ''} ${b.error ?? ''}`.replace(/\s+/g, ' ').trim()
  if (r.outcome === 'failed' && r.status) return `prod từ chối: ${r.status} ${b.code ?? ''} ${b.error ?? ''}`.trim()
  return `lỗi: ${b.error ?? '?'}`
}

/**
 * Converts the plan, runs it through runApiDelivery and prints one line per task. `makeDeps` builds the client and uploader
 * and is only called when there is something to send. A later line of a shared group goes in a second pass, once the first
 * line has its file on prod.
 * @returns {Promise<{ exitCode: number, results: any[], skipped: any[], stopped: string|null }>}
 */
export async function deliverPlanViaApi({ plan, storageRoot, ledgerPath, makeDeps, dryRun = false, previewOf = null, log = console.log }) {
  let { lines, skipped } = planLinesToApi(plan, { storageRoot, sharedIds: sharedIdsFromLedger(ledgerPath) })
  const results = []
  let stopped = null
  if (lines.length) {
    const { client, uploader } = makeDeps()
    log(`\n== Giao qua API${dryRun ? ' (dry run — server không ghi gì)' : ''}: ${lines.length} dòng ==`)
    try {
      for (let pass = 0; lines.length && pass < 3; pass++) {
        const r = await runApiDelivery({ lines, client, uploader, ledgerPath, log, previewOf, dryRun })
        results.push(...r.results)
        const waiting = new Set(skipped.filter(s => s.waitingFor).map(s => s.taskKey))
        if (dryRun || !waiting.size || !r.applied) break
        const again = planLinesToApi(plan, { storageRoot, sharedIds: sharedIdsFromLedger(ledgerPath) })
        skipped = [...skipped.filter(s => !waiting.has(s.taskKey)), ...again.skipped.filter(s => waiting.has(s.taskKey))]
        lines = again.lines.filter(l => waiting.has(l.taskKey))
      }
    } catch (e) {
      if (!(e instanceof DeliveryGaveUp || e instanceof DeliveryStopped)) throw e
      stopped = e.message
    }
  }
  log(`\n== Kết quả API ==`)
  for (const r of results) log(`  ${r.taskKey}  ${describe(r)}`)
  for (const s of skipped) log(`  ${s.taskKey}  ${s.waitingFor ? 'chờ' : 'không gửi'}: ${s.reason}`)
  const count = o => results.filter(r => r.outcome === o).length
  log(`${results.length} dòng gửi qua API · ghi ${count('applied')} · dry run ${count('dryRun')} · đã có ${count('alreadyApplied')} · prod bỏ qua ${count('skipped')} · lỗi ${count('failed')} · không gửi ${skipped.length}`)
  if (stopped) log(`DỪNG: ${stopped} — ledger giữ nguyên, chạy lại lệnh để gửi tiếp`)
  if (dryRun && results.length) log('DRY-RUN qua API — server không ghi gì; file đã upload vào thư mục chờ, lần chạy thật dùng lại.')
  return { exitCode: stopped || count('failed') ? 1 : 0, results, skipped, stopped }
}
