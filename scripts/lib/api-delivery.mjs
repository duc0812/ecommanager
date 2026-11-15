import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { DeliveryGaveUp, DeliveryStopped } from './delivery-client.mjs'

// Delivers lines through the Artwork Delivery API: upload each missing print file to the task's incoming folder on Drive,
// then commit. The ledger is written (atomically, fsynced) right after every upload and before the commit, so a crash at any
// point resumes without a second upload; a commit the server already applied answers alreadyApplied. Ledger entries are
// keyed per delivery (task + a hash of what is delivered), never per task alone. Nothing here deletes on Drive.

const PREVIEW_MIN_BYTES = 30 * 1024 * 1024
const DROP_PREVIEW_STATUSES = new Set([400, 404, 409, 413])

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Only a missing file is an empty ledger; an unreadable or corrupt one stops the run before anything is uploaded. */
export function readLedger(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return { lines: {} }
    throw new Error(`Không đọc được ledger ${file}: ${e?.message ?? e}`)
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('không phải object')
    return parsed
  } catch (e) {
    throw new Error(`Ledger ${file} bị hỏng (${e?.message ?? e}); không ghi đè, hãy kiểm tra file rồi chạy lại`)
  }
}

export function writeLedger(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(ledger, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e) {
      if ((e?.code !== 'EPERM' && e?.code !== 'EBUSY') || attempt >= 4) throw e
      sleepSync(50 * (attempt + 1))
    }
  }
}

const fileKey = f => `${f.kind}/${f.printArea}`
const lowerArea = f => String(f.printArea).toLowerCase()
const bySortedArea = (a, b) => (lowerArea(a) < lowerArea(b) ? -1 : lowerArea(a) > lowerArea(b) ? 1 : 0)
const sizeOrNull = n => (Number.isInteger(n) && n > 0 ? n : null)
const statOf = p => { try { const s = fs.statSync(p); return { size: s.size, mtimeMs: s.mtimeMs } } catch { return null } }
const fatal = e => e instanceof DeliveryGaveUp || e instanceof DeliveryStopped

function deliveryKey(line) {
  const files = [...line.files]
    .sort((a, b) => bySortedArea(a, b) || String(a.kind).localeCompare(String(b.kind)))
    .map(f => {
      const st = statOf(f.path)
      return { kind: f.kind, printArea: f.printArea, fileName: f.fileName, size: Number.isInteger(f.size) ? f.size : st?.size ?? null, mtimeMs: st?.mtimeMs ?? null, shortcutOf: f.shortcutOf ?? null }
    })
  const payload = { action: line.action, retire: [...(line.retire ?? [])].sort(), files }
  return `${line.taskKey}#${crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex')}`
}

function takeLock(ledgerPath) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
  const lock = `${ledgerPath}.lock`
  let fd
  try {
    fd = fs.openSync(lock, 'wx')
  } catch (e) {
    if (e?.code === 'EEXIST') throw new Error(`Đang có lần chạy khác dùng ledger này (${lock}). Nếu chắc chắn không còn, xóa file khóa rồi chạy lại.`)
    throw e
  }
  try { fs.writeSync(fd, String(process.pid)) } catch { /* the lock exists; its content is only a hint */ }
  return () => {
    try { fs.closeSync(fd) } catch { /* already closed */ }
    try { fs.unlinkSync(lock) } catch { /* already gone */ }
  }
}

/**
 * @param {{
 *   lines: { taskKey: string, action: 'push'|'replace'|'retire'|'revert', files: { kind: string, printArea: string, path: string, fileName: string, mimeType: string, widthPx?: number|null, heightPx?: number|null, shortcutOf?: string|null, size?: number }[], retire: string[], eventMessage?: string, retireSources?: string[], allowFinished?: boolean, revertReadiness?: string }[],
 *   client: { taskState: Function, commit: Function, putPreview: Function },
 *   uploader: { upload: (f: { path: string, name: string, mimeType: string, parentId: string }) => Promise<{ id: string, size: number }> },
 *   ledgerPath: string,
 *   log?: (msg: string) => void,
 *   uploads?: number,
 *   previewOf?: (path: string) => Promise<Buffer|null>|Buffer|null,
 * }} opts
 */
export async function runApiDelivery({ lines, client, uploader, ledgerPath, log = console.log, uploads = 3, previewOf = null }) {
  const release = takeLock(ledgerPath)
  try {
    return await run({ lines, client, uploader, ledgerPath, log, uploads, previewOf })
  } finally {
    release()
  }
}

async function run({ lines, client, uploader, ledgerPath, log, uploads, previewOf }) {
  const ledger = readLedger(ledgerPath)
  ledger.lines ??= {}
  const save = () => writeLedger(ledgerPath, ledger)
  const counts = { applied: 0, skipped: 0, alreadyApplied: 0, failed: 0 }

  async function sendPreviews(led) {
    if (!previewOf || !led.pendingPreviews?.length) return
    const pending = led.pendingPreviews
    const left = []
    try {
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i]
        try {
          const jpeg = await previewOf(p.path)
          if (!jpeg) continue
          const r = await client.putPreview(p.artworkId, jpeg)
          if (!r.ok) {
            log(`  xem trước ${p.artworkId}: HTTP ${r.status}`)
            if (!DROP_PREVIEW_STATUSES.has(r.status)) left.push(p)
          }
        } catch (e) {
          if (fatal(e)) { left.push(...pending.slice(i)); throw e }
          log(`  xem trước ${p.artworkId} lỗi: ${e instanceof Error ? e.message : e}`)
          left.push(p)
        }
      }
    } finally {
      led.pendingPreviews = left
      save()
    }
  }

  function skipOnProd(key, led, res) {
    const reason = { code: res.body?.code ?? null, error: res.body?.error ?? null, status: res.status }
    led.skippedOnProd = reason
    save()
    log(`${key}: bỏ qua trên prod (${reason.status} ${reason.code ?? ''} ${reason.error ?? ''})`)
    counts.skipped++
  }

  async function deliver(line) {
    const key = line.taskKey
    const ledgerKey = deliveryKey(line)
    const led = ledger.lines[ledgerKey] ?? (ledger.lines[ledgerKey] = { taskKey: key, action: line.action, files: {} })
    led.files ??= {}
    if (led.applied) {
      counts.alreadyApplied++
      await sendPreviews(led)
      return
    }
    const files = [...line.files].sort(bySortedArea)

    const sizes = new Map()
    for (const f of files) {
      if (!f.shortcutOf) continue
      const size = Number.isInteger(f.size) && f.size > 0 ? f.size : statOf(f.path)?.size
      if (!size) throw new Error(`${key}: không biết dung lượng của lối tắt ${f.fileName} (thiếu size và không có file local)`)
      sizes.set(fileKey(f), size)
    }

    const st = await client.taskState(key)
    if (!st.ok) return skipOnProd(key, led, st)
    const state = st.body

    const todo = []
    for (const f of files) {
      if (f.shortcutOf) { led.files[fileKey(f)] = { driveFileId: f.shortcutOf, shortcutOf: f.shortcutOf, size: sizes.get(fileKey(f)) }; continue }
      if (!led.files[fileKey(f)]?.driveFileId) todo.push(f)
    }
    save()

    let next = 0
    const worker = async () => {
      while (next < todo.length) {
        const f = todo[next++]
        const up = await uploader.upload({ path: f.path, name: f.fileName, mimeType: f.mimeType, parentId: state.incomingFolder.id })
        led.files[fileKey(f)] = { driveFileId: up.id, size: up.size, path: f.path, fileName: f.fileName }
        save()
        log(`${key}: đã upload ${f.fileName}`)
      }
    }
    const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(uploads, todo.length)) }, worker))
    const failed = settled.find(s => s.status === 'rejected')
    if (failed) throw failed.reason

    const body = {
      action: line.action,
      expected: { status: state.status, liveIds: (state.artworks ?? []).map(a => a.id) },
      files: files.map(f => {
        const e = led.files[fileKey(f)]
        const out = {
          kind: f.kind, printArea: f.printArea, fileName: f.fileName, driveFileId: e.driveFileId, size: e.size, mimeType: f.mimeType,
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
          if (!a?.id || a.kind !== 'PRINT' || !a.driveFileId) continue
          const f = files.find(x => x.kind === 'PRINT' && !x.shortcutOf && led.files[fileKey(x)]?.driveFileId === a.driveFileId)
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
      if (fatal(e)) { save(); throw e }
      counts.failed++
      log(`${line.taskKey}: lỗi ${e instanceof Error ? e.message : e}`)
    }
  }
  return counts
}
