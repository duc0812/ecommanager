import fs from 'fs'
import path from 'path'
import { DeliveryGaveUp } from './delivery-client.mjs'

// Delivers lines through the Artwork Delivery API: upload each missing print file to the task's incoming folder on Drive,
// then commit. The ledger is written (atomically) right after every upload and before the commit, so a crash at any point
// resumes without a second upload; a commit the server already applied answers alreadyApplied. Nothing here deletes on Drive.

const PREVIEW_MIN_BYTES = 30 * 1024 * 1024

export function readLedger(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { lines: {} } }
}
export function writeLedger(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(ledger, null, 2))
  fs.renameSync(`${file}.tmp`, file)
}

const fileKey = f => `${f.kind}/${f.printArea}`
const bySortedArea = (a, b) => {
  const x = String(a.printArea).toLowerCase()
  const y = String(b.printArea).toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}
const sizeOrNull = n => (Number.isFinite(n) && n > 0 ? n : null)
const statOf = p => { try { const s = fs.statSync(p); return { size: s.size, mtimeMs: s.mtimeMs } } catch { return null } }

/**
 * @param {{
 *   lines: { taskKey: string, action: 'push'|'replace'|'retire'|'revert', files: { kind: string, printArea: string, path: string, fileName: string, mimeType: string, widthPx?: number|null, heightPx?: number|null, shortcutOf?: string|null }[], retire: string[], eventMessage?: string, retireSources?: string[], allowFinished?: boolean, revertReadiness?: string }[],
 *   client: { taskState: Function, commit: Function, putPreview: Function },
 *   uploader: { upload: (f: { path: string, name: string, mimeType: string, parentId: string }) => Promise<{ id: string, size: number }> },
 *   ledgerPath: string,
 *   log?: (msg: string) => void,
 *   uploads?: number,
 *   previewOf?: (path: string) => Promise<Buffer|null>|Buffer|null,
 * }} opts
 */
export async function runApiDelivery({ lines, client, uploader, ledgerPath, log = console.log, uploads = 3, previewOf = null }) {
  const ledger = readLedger(ledgerPath)
  ledger.lines ??= {}
  const save = () => writeLedger(ledgerPath, ledger)
  const counts = { applied: 0, skipped: 0, alreadyApplied: 0, failed: 0 }

  async function sendPreviews(led) {
    if (!previewOf || !led.pendingPreviews?.length) return
    const left = []
    for (const p of led.pendingPreviews) {
      try {
        const jpeg = await previewOf(p.path)
        if (!jpeg) continue
        const r = await client.putPreview(p.artworkId, jpeg)
        if (!r.ok) { log(`  xem trước ${p.artworkId}: HTTP ${r.status}`); left.push(p) }
      } catch (e) {
        if (e instanceof DeliveryGaveUp) { led.pendingPreviews = [...left, p, ...led.pendingPreviews.slice(led.pendingPreviews.indexOf(p) + 1)]; save(); throw e }
        log(`  xem trước ${p.artworkId} lỗi: ${e instanceof Error ? e.message : e}`)
        left.push(p)
      }
    }
    led.pendingPreviews = left
    save()
  }

  async function skipOnProd(key, led, res) {
    const reason = { code: res.body?.code ?? null, error: res.body?.error ?? null, status: res.status }
    led.skippedOnProd = reason
    save()
    log(`${key}: bỏ qua trên prod (${reason.status} ${reason.code ?? ''} ${reason.error ?? ''})`)
    counts.skipped++
  }

  async function deliver(line) {
    const key = line.taskKey
    const led = ledger.lines[key] ?? (ledger.lines[key] = { files: {} })
    led.files ??= {}
    if (led.applied) {
      counts.alreadyApplied++
      await sendPreviews(led)
      return
    }
    const st = await client.taskState(key)
    if (!st.ok) return skipOnProd(key, led, st)
    const state = st.body
    const files = [...line.files].sort(bySortedArea)

    const todo = []
    for (const f of files) {
      if (f.shortcutOf) { led.files[fileKey(f)] = { ...(led.files[fileKey(f)] ?? {}), driveFileId: f.shortcutOf, shortcutOf: f.shortcutOf, size: statOf(f.path)?.size ?? 0 }; continue }
      const entry = led.files[fileKey(f)]
      const now = statOf(f.path)
      const same = entry?.driveFileId && entry.path === f.path && entry.fileName === f.fileName && (!now || (entry.size === now.size && entry.mtimeMs === now.mtimeMs))
      if (!same) todo.push(f)
    }
    save()

    let next = 0
    const worker = async () => {
      while (next < todo.length) {
        const f = todo[next++]
        const before = statOf(f.path)
        const up = await uploader.upload({ path: f.path, name: f.fileName, mimeType: f.mimeType, parentId: state.incomingFolder.id })
        led.files[fileKey(f)] = { driveFileId: up.id, size: up.size, mtimeMs: before?.mtimeMs ?? null, path: f.path, fileName: f.fileName }
        save()
        log(`${key}: đã upload ${f.fileName}`)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(uploads, todo.length)) }, worker))

    const body = {
      action: line.action,
      expected: { status: state.status, liveIds: (state.artworks ?? []).map(a => a.id) },
      files: files.map(f => {
        const e = led.files[fileKey(f)]
        const out = {
          kind: f.kind, printArea: f.printArea, fileName: f.fileName, driveFileId: e.driveFileId, size: e.size ?? 0, mimeType: f.mimeType,
          widthPx: sizeOrNull(f.widthPx), heightPx: sizeOrNull(f.heightPx),
        }
        if (f.shortcutOf) out.shortcutOf = f.shortcutOf
        return out
      }),
      retire: line.retire ?? [],
    }
    for (const k of ['retireSources', 'eventMessage', 'allowFinished', 'revertReadiness']) if (line[k] !== undefined) body[k] = line[k]

    const res = await client.commit(key, body)
    if (res.ok) {
      led.applied = new Date().toISOString()
      led.result = res.body
      delete led.skippedOnProd
      led.pendingPreviews = []
      if (previewOf) {
        for (const a of res.body?.artworks ?? []) {
          if (!a?.id || a.kind !== 'PRINT') continue
          const f = files.find(x => x.kind === 'PRINT' && String(x.printArea).toLowerCase() === String(a.printArea).toLowerCase() && !x.shortcutOf)
          if (f && (statOf(f.path)?.size ?? 0) >= PREVIEW_MIN_BYTES) led.pendingPreviews.push({ artworkId: a.id, path: f.path })
        }
      }
      save()
      counts.applied++
      log(`${key}: đã áp dụng${res.body?.alreadyApplied ? ' (server báo đã có)' : ''}`)
      await sendPreviews(led)
      return
    }
    if (res.status === 409) {
      const again = await client.taskState(key)
      if (again.ok) log(`${key}: trạng thái hiện tại ${again.body?.status}`)
    }
    return skipOnProd(key, led, res)
  }

  for (const line of lines) {
    try {
      await deliver(line)
    } catch (e) {
      if (e instanceof DeliveryGaveUp) { save(); throw e }
      counts.failed++
      log(`${line.taskKey}: lỗi ${e instanceof Error ? e.message : e}`)
    }
  }
  return counts
}
