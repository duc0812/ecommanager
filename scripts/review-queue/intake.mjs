import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createDeliveryClient } from '../lib/delivery-client.mjs'
import { deliverPlanViaApi, planLinesToApi, sharedIdsFromLedger } from '../lib/plan-to-api.mjs'
import { ACTIVE_STATUSES, newItemId, openQueue } from './store.mjs'
import { resolveTemplate } from './template.mjs'
import { DEFAULT_ARTWORK_BUILDER, MOCKUP_MISSING, builderOf, customValues, resolveMockup } from './mockup.mjs'

// Intake of the local review queue (spec 7.2, 12.1, 12.2, 12.4): the push CLIs run with `--via api --to-queue` hand their API
// lines here instead of delivering them. Each line (or shared group) is copied into items/<id>/v<n>/, gets a JPEG preview per
// file, the customer's own preview and the store photo, and waits for the owner. A group that only reuses a file already on
// Drive has nothing new to look at and is delivered by the caller as today.

export const QUEUE_NOTE = 'Đang chờ chủ shop duyệt ở máy local (tối đa 3 giờ)'
export const HOLDING_NOTE = 'Chủ shop đang giữ lại ở máy local — chưa có hạn'
const HOLDING_STATUSES = ['rejected', 'fixing', 'needs_look']
const COUNTING_STATUSES = ['waiting', 'qa_failed']
export const DEFAULT_QUEUE_ROOT = 'D:\\Ecom manager\\review-queue'
export const PREVIEW_MAX_PX = 1600
const DOWNLOAD_TIMEOUT_MS = 15_000
const DOWNLOAD_MAX_BYTES = 40 * 1024 * 1024
const PENDING = 'rq-pending:'
const NOTE_BUDGET_MS = 30_000
const NOTE_TIMEOUT_MS = 10_000
const QA_VERDICTS = ['pass', 'fail', 'unchecked']

export const queueRootFromEnv = () => process.env.REVIEW_QUEUE_ROOT || DEFAULT_QUEUE_ROOT
/** Every writer of a new version of a group (intake, fix jobs) holds this lock, so two writers never pick the same v<n>. */
export const intakeLockKey = groupKey => `intake:${groupKey}`

const errText = e => (e instanceof Error ? e.message : String(e))

/** Client for the prod notes only: a short budget and a per-request abort, so a slow prod never holds the run for long. */
export function makeNoteClient(opts = {}) {
  return createDeliveryClient({ budgetMs: NOTE_BUDGET_MS, timeoutMs: NOTE_TIMEOUT_MS, ...opts })
}

/**
 * Tells prod when an item stops counting down (rejected, fixing, needs_look → HOLDING_NOTE) and when it counts again after that
 * (waiting, qa_failed → QUEUE_NOTE). One note per member key and change, remembered as a `note_state` event whose message is the
 * note; intake's first QUEUE_NOTE counts as the starting state. A failure is a warning line and a `note_failed` event, never an error.
 * @returns {Promise<string|null>} the note sent, or null
 */
export async function noteQueueState(queue, itemId, client, log = console.log) {
  if (!client) return null
  let message = null
  try {
    const item = await queue.get(itemId)
    message = HOLDING_STATUSES.includes(item?.status) ? HOLDING_NOTE : COUNTING_STATUSES.includes(item?.status) ? QUEUE_NOTE : null
    if (!message) return null
    const last = (await queue.events(itemId)).filter(e => e.type === 'note_state').pop()?.message ?? QUEUE_NOTE
    if (last === message) return null
    const keys = await queue.memberKeys(itemId)
    for (const k of keys.length ? keys : [item.taskKey]) {
      const r = await client.note(k, message)
      if (r && r.ok === false) throw new Error(`HTTP ${r.status} ${r.body?.code ?? ''} ${r.body?.error ?? ''}`.trim())
    }
    await queue.addEvent(itemId, 'note_state', message)
    return message
  } catch (e) {
    log(`CẢNH BÁO: ${itemId}: không ghi được ghi chú lên prod (${errText(e)})`)
    try { await queue.addEvent(itemId, 'note_failed', `Không ghi được ghi chú "${message ?? '?'}" lên prod: ${errText(e)}`) } catch { /* the warning line is enough */ }
    return null
  }
}

const lineShape = l => JSON.stringify([
  l.taskKey, l.action ?? null, l.expectedStatus ?? null, [...(l.planIds ?? [])].map(String).sort(), [...(l.retire ?? [])].map(String).sort(),
])
/** The api lines would do something else on prod (action, expected status, planned ids, retired ids). */
const apiLinesDiffer = (stored, fresh) => (stored ?? []).map(lineShape).sort().join('|') !== (fresh ?? []).map(lineShape).sort().join('|')

/**
 * planLinesToApi for the queue: a later line of a shared group whose first line has no Drive file yet carries a pending
 * marker instead of waiting, so it joins its first line's group item.
 */
export function queueApiLines(plan, { storageRoot, ledgerPath }) {
  const known = sharedIdsFromLedger(ledgerPath)
  return planLinesToApi(plan, { storageRoot, sharedIds: (from, key) => known(from, key) ?? PENDING + JSON.stringify([from, key]) })
}

function normalizeLine(line) {
  return {
    ...line,
    files: (line.files ?? []).map(f => {
      if (typeof f.shortcutOf !== 'string' || !f.shortcutOf.startsWith(PENDING)) return { ...f }
      const [sharedFrom, sharedKey] = JSON.parse(f.shortcutOf.slice(PENDING.length))
      const { shortcutOf: _drop, ...rest } = f
      return { ...rest, sharedFrom, sharedKey }
    }),
  }
}

/**
 * Turns a group item's later lines into deliverable lines once the first line's file is on Drive: `sharedIds(taskKey, fileKey)`
 * (e.g. sharedIdsFromLedger(meta.ledgerPath)) gives the Drive id. Lines still without one are listed in `waiting`.
 * @returns {{ lines: any[], waiting: string[] }}
 */
export function resolveShared(apiLines, sharedIds) {
  const waiting = []
  const lines = (apiLines ?? []).map(line => {
    let open = false
    const files = (line.files ?? []).map(f => {
      if (!f.sharedFrom || f.shortcutOf) return { ...f }
      const id = sharedIds(f.sharedFrom, f.sharedKey) ?? null
      if (!id) { open = true; return { ...f } }
      const { sharedFrom: _a, sharedKey: _b, ...rest } = f
      return { ...rest, shortcutOf: id }
    })
    if (open) waiting.push(line.taskKey)
    return { ...line, files }
  })
  return { lines, waiting }
}

function groupLines(apiLines) {
  const groups = new Map()
  for (const raw of apiLines) {
    const line = normalizeLine(raw)
    const key = line.files.find(f => f.sharedFrom)?.sharedFrom ?? line.taskKey
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(line)
  }
  for (const [key, lines] of groups) lines.sort((a, b) => (a.taskKey === key ? -1 : b.taskKey === key ? 1 : 0))
  return groups
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', d => hash.update(d)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}

/** White behind the art, unless the art itself is mostly white (white ink for a dark garment): then dark grey keeps it visible. Same rule as previewBackground in scripts/lib/push-local-renders.mjs. */
async function previewBackground(sharp, original) {
  const { data, info } = await sharp(original, { limitInputPixels: false }).resize(256, 256, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const n = info.channels
  let opaque = 0, white = 0
  for (let i = 0; i < data.length; i += n) {
    if (data[i + n - 1] <= 128) continue
    opaque++
    if ((n >= 4 ? Math.min(data[i], data[i + 1], data[i + 2]) : data[i]) > 235) white++
  }
  return opaque && white > opaque / 2 ? '#333333' : '#ffffff'
}

/** JPEG preview (longest side 1600 px, quality 85) of a file path or an image buffer. */
export async function makePreview(input, dst) {
  const { default: sharp } = await import('sharp')
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const background = await previewBackground(sharp, input)
  await sharp(input, { limitInputPixels: false })
    .rotate()
    .resize({ width: PREVIEW_MAX_PX, height: PREVIEW_MAX_PX, fit: 'inside', withoutEnlargement: true })
    .flatten({ background })
    .jpeg({ quality: 85 })
    .toFile(dst)
  return dst
}

/** One image from a CDN (customer preview, store photo), http(s) only, 15 s timeout. */
export async function downloadImage(url, { timeoutMs = DOWNLOAD_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const u = new URL(url)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`chỉ tải ảnh http(s): ${url}`)
  const res = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > DOWNLOAD_MAX_BYTES) throw new Error(`ảnh quá lớn (${buf.length} byte)`)
  return buf
}

function parseFields(json) {
  try {
    const v = JSON.parse(json || '[]')
    return Array.isArray(v)
      ? v.filter(f => f && typeof (f.key ?? f.name) === 'string').map(f => ({ key: String(f.key ?? f.name), value: String(f.value ?? '') }))
      : []
  } catch {
    return []
  }
}

const isoOf = v => (v == null ? null : typeof v === 'number' || typeof v === 'bigint' ? new Date(Number(v)).toISOString() : String(v))

const META_SQL = `SELECT ol.productTitle, ol.variantTitle, ol.sku, ol.resolvedSupplierSku, ol.customAttributesJson, ol.customallFieldsJson,
       ol.previewCdnUrl, ol.imageUrl, o.shopifyOrderNumber, o.placedAt
  FROM DesignTask t
  LEFT JOIN OrderLine ol ON ol.orderId = t.orderId AND ol.shopifyLineId = t.shopifyLineId
  LEFT JOIN "Order" o ON o.id = t.orderId
 WHERE t.taskKey = ? LIMIT 1`
const PROD_MOCKUP_SQL = `SELECT COUNT(*) AS n FROM DesignArtwork a JOIN DesignTask t ON t.orderId = a.orderId AND t.shopifyLineId = a.shopifyLineId
 WHERE t.taskKey = ? AND a.kind = 'MOCKUP' AND a.removedAt IS NULL`

async function lineInfo({ snapshot, taskKey, planLine, log }) {
  let row = null
  let prodMockup = false
  if (snapshot) {
    try {
      row = (await snapshot.execute({ sql: META_SQL, args: [taskKey] })).rows[0] ?? null
    } catch (e) {
      log(`${taskKey}: không đọc được thông tin dòng từ snapshot: ${errText(e)}`)
    }
    try {
      prodMockup = Number((await snapshot.execute({ sql: PROD_MOCKUP_SQL, args: [taskKey] })).rows[0]?.n ?? 0) > 0
    } catch { /* an older snapshot without DesignArtwork: prod has no known mockup */ }
  }
  const attrs = parseFields(row?.customAttributesJson)
  const custom = [...attrs.filter(f => !f.key.startsWith('_')), ...parseFields(row?.customallFieldsJson)].map(f => ({ name: f.key, value: f.value }))
  const attrPreview = attrs.find(f => (f.key === '_customall_preview' || f.key === '_pers') && /^https?:\/\//i.test(f.value.trim()))?.value.trim() ?? null
  return {
    taskKey,
    productTitle: row?.productTitle ?? planLine?.productTitle ?? '',
    variantTitle: row?.variantTitle ?? null,
    sku: row?.sku ?? null,
    supplierSku: row?.resolvedSupplierSku ?? null,
    orderNumber: row?.shopifyOrderNumber ?? planLine?.orderNumber ?? null,
    placedAt: isoOf(row?.placedAt),
    custom,
    customerPreviewUrl: row?.previewCdnUrl || attrPreview || null,
    storeImageUrl: row?.imageUrl || null,
    // the builder the shopper used (its preview is redrawn, owner 11/17/2026) and whether prod already holds a live MOCKUP row
    builder: builderOf(attrs),
    prodMockup,
    // the print template the page lays every piece on (null = draw the files one by one)
    template: await resolveTemplate(snapshot, taskKey, log),
  }
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

function normQa(qa) {
  return {
    verdict: QA_VERDICTS.includes(qa?.verdict) ? qa.verdict : 'unchecked',
    items: Array.isArray(qa?.items) ? qa.items.map(String) : [],
    ...(isObject(qa?.inputs) ? { inputs: qa.inputs } : {}),
  }
}

/** `inputs` (auto render's check data, re-run by `auto_render.py --qa-item`): one line keeps its own, a group keeps `{ byKey }`. */
function combineQa(keys, qaByKey) {
  const list = keys.map(k => [k, normQa(qaByKey?.[k])])
  const verdict = list.some(([, q]) => q.verdict === 'fail') ? 'fail' : list.every(([, q]) => q.verdict === 'pass') ? 'pass' : 'unchecked'
  const out = { verdict, items: list.flatMap(([k, q]) => q.items.map(i => (keys.length > 1 ? `${k}: ${i}` : i))) }
  const withInputs = list.filter(([, q]) => q.inputs)
  if (keys.length === 1 && withInputs.length) out.inputs = withInputs[0][1].inputs
  else if (withInputs.length) out.inputs = { byKey: Object.fromEntries(withInputs.map(([k, q]) => [k, q.inputs])) }
  return out
}

const partBase = f => `${f.kind ?? 'PRINT'}_${f.printArea}`.replace(/[^A-Za-z0-9._-]+/g, '_')

/**
 * @param {{
 *   plan: { lines: any[] }, apiLines: any[], queue: any, snapshot: any,
 *   qaByKey?: Record<string, { verdict: string, items: string[] }>, client?: { note: (key: string, message: string) => Promise<any> } | null,
 *   previewer?: (input: string|Buffer, dst: string) => Promise<any>, download?: (url: string, opts?: any) => Promise<Buffer>,
 *   source?: { cli?: string, spec?: string|null, out?: string, ledgerPath?: string }, log?: (m: string) => void,
 * }} opts
 * Notes to prod go out after every group is in the queue (a new item: every key; a new version: the keys it added); the first
 * failure stops them (one warning line, keys in `unnoted`).
 * @returns {Promise<{ enqueued: string[], unchanged: string[], bypassed: string[], refused: { taskKey: string, reason: string }[], reasons: Record<string, string>, unnoted: string[] }>}
 */
export async function enqueuePlan({
  plan, apiLines, queue, snapshot, qaByKey = {}, client = null, previewer = makePreview, download = downloadImage,
  source = {}, log = console.log, mockup = resolveMockup, artworkBuilder = DEFAULT_ARTWORK_BUILDER,
}) {
  const out = { enqueued: [], unchanged: [], bypassed: [], refused: [], reasons: {}, unnoted: [] }
  const toNote = []
  const updated = []
  const planByKey = new Map((plan?.lines ?? []).map(l => [l.taskKey, l]))
  const refuse = (keys, reason) => { for (const k of keys) out.refused.push({ taskKey: k, reason }) }

  for (const [groupKey, lines] of groupLines(apiLines ?? [])) {
    const keys = lines.map(l => l.taskKey)
    let elsewhere = null
    for (const k of keys) {
      const held = await queue.activeByTaskKey(k)
      if (held && held.groupKey !== groupKey) { elsewhere = held; break }
    }
    if (elsewhere) { refuse(keys, `đã có trong hàng chờ ${elsewhere.id}`); continue }
    if (!keys.includes(groupKey)) {
      refuse(keys, `dùng chung file với ${groupKey} nhưng ${groupKey} không có trong lần chạy này — giao hoặc đưa ${groupKey} vào hàng chờ trước`)
      continue
    }
    const problems = []
    const locals = []
    for (const l of lines) {
      for (const f of l.files) {
        if (!f.path) continue
        if (fs.existsSync(f.path) && fs.statSync(f.path).isFile()) { locals.push({ line: l, file: f }); continue }
        if (f.knownDriveFileId) { delete f.path; continue }
        problems.push(`${l.taskKey}: không thấy file ${f.fileName} (${f.path})`)
      }
    }
    if (problems.length) { refuse(keys, problems.join('; ')); continue }
    // the mockup of every line comes first: a group that only reuses Drive prints still enters the queue when its mockup is a new file
    const infos = []
    for (const l of lines) infos.push(await lineInfo({ snapshot, taskKey: l.taskKey, planLine: planByKey.get(l.taskKey), log }))
    const work = path.join(queue.root, 'tmp', `${groupKey}-${process.pid}-${Date.now()}`.replace(/[^A-Za-z0-9._-]+/g, '_'))
    try {
      const mockups = await mockupsFor({ lines, infos, locals, work })
      if (!locals.length) { out.bypassed.push(...keys); continue }
      const r = await queue.withLock(intakeLockKey(groupKey), () => enqueueGroup({ groupKey, lines, locals, infos, mockups }))
      if (r.outcome === 'unchanged') {
        out.unchanged.push(...keys)
        if (r.reason) for (const k of keys) out.reasons[k] = r.reason
        continue
      }
      out.enqueued.push(...keys)
      if (r.created) toNote.push({ itemId: r.itemId, keys: lines.map(l => l.taskKey) })
      else {
        if (r.addedKeys?.length) toNote.push({ itemId: r.itemId, keys: r.addedKeys })
        updated.push(r.itemId)
      }
    } catch (e) {
      refuse(keys, e?.code === 'key_held' ? `đã có trong hàng chờ ${e.itemId}` : `lỗi khi đưa vào hàng chờ: ${errText(e)}`)
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
      try { fs.rmdirSync(path.dirname(work)) } catch { /* other work folders, or already gone */ }
    }
  }
  await notifyProd()
  for (const id of updated) await noteQueueState(queue, id, client, log)
  return out

  async function notifyProd() {
    const pending = toNote.flatMap(n => n.keys.map(k => ({ itemId: n.itemId, key: k })))
    for (let i = 0; i < pending.length; i++) {
      const { itemId, key } = pending[i]
      try {
        if (!client) throw new Error('không có client')
        const r = await client.note(key, QUEUE_NOTE)
        if (r && r.ok === false) throw new Error(`HTTP ${r.status} ${r.body?.code ?? ''} ${r.body?.error ?? ''}`.trim())
        await queue.addEvent(itemId, 'note', `Đã ghi chú lên prod: ${key}`)
      } catch (e) {
        const left = pending.slice(i)
        out.unnoted = left.map(p => p.key)
        log(`CẢNH BÁO: không ghi được ghi chú lên prod (${errText(e)}) — dừng gửi ghi chú; ${left.length} dòng vẫn ở hàng chờ nhưng prod chưa biết: ${out.unnoted.join(', ')}`)
        for (const p of left) {
          try { await queue.addEvent(p.itemId, 'note_failed', `Không ghi được ghi chú lên prod cho ${p.key}: ${errText(e)}`) } catch { /* the warning line is enough */ }
        }
        return
      }
    }
  }

  /** The mockup of every line (built into `work`, copied into the version like any other file; a missing one fails QA). */
  async function mockupsFor({ lines, infos, locals, work }) {
    const mockups = []
    for (const [i, l] of lines.entries()) {
        const info = infos[i]
        const hasMockupFile = (l.files ?? []).some(f => f.kind === 'MOCKUP')
        let storeImage = null
        if (!hasMockupFile && !info.prodMockup && !info.customerPreviewUrl && !info.builder && !customValues(info.custom).length && info.storeImageUrl) {
          try {
            fs.mkdirSync(work, { recursive: true })
            const dst = path.join(work, `store-${i}.jpg`)
            await previewer(await download(info.storeImageUrl, { timeoutMs: DOWNLOAD_TIMEOUT_MS }), dst)
            storeImage = dst
          } catch (e) {
            log(`${l.taskKey}: không tải được ảnh biến thể ${info.storeImageUrl} cho mockup (${errText(e)})`)
          }
        }
        let m
        try {
          m = await mockup({ info: { ...info, storeImage }, hasMockupFile, outDir: path.join(work, String(i)), root: artworkBuilder, log })
        } catch (e) {
          m = { state: 'missing', note: `lỗi dựng mockup: ${errText(e)}`, reason: `lỗi dựng mockup: ${errText(e)}` }
          log(`${l.taskKey}: ${MOCKUP_MISSING} — ${m.reason}`)
        }
        mockups.push({ state: m.state, note: m.note ?? '', ...(m.reason ? { reason: m.reason } : {}) })
        if (m.file) {
          l.files = [...(l.files ?? []), m.file]
          locals.push({ line: l, file: m.file })
        }
    }
    return mockups
  }

  async function enqueueGroup({ groupKey, lines, locals, infos, mockups }) {
    const sources = new Map()
    const used = new Set()
    for (const { line, file } of locals) {
      const src = path.resolve(file.path)
      if (sources.has(src)) continue
      let part = partBase(file)
      if (used.has(part)) part = `${part}_${line.taskKey}`.replace(/[^A-Za-z0-9._-]+/g, '_')
      for (let i = 2; used.has(part); i++) part = `${partBase(file)}_${i}`
      used.add(part)
      sources.set(src, { sha: await sha256File(src), part, ext: path.extname(src).toLowerCase(), file, line })
    }
    const shaKey = [...sources.values()].map(s => s.sha).sort().join('|')
    const taskKeys = [...new Set(lines.map(l => l.taskKey))].sort()
    const active = (await queue.list({ statuses: ACTIVE_STATUSES })).find(i => i.groupKey === groupKey) ?? null
    let prevDir = null
    let prevKeys = []
    let refresh = false
    if (active) {
      if (active.status === 'fixing') return { outcome: 'unchanged', itemId: active.id, reason: 'agent đang sửa' }
      const cur = (await queue.versions(active.id)).find(v => v.n === active.version)
      prevKeys = await queue.memberKeys(active.id)
      const sameKeys = prevKeys.join('|') === taskKeys.join('|')
      // a needs_look item, or api lines that now mean something else on prod, is re-recorded even with the same bytes
      refresh = active.status === 'needs_look' || apiLinesDiffer(active.apiLines, lines)
      if (cur && sameKeys && !refresh && (cur.files ?? []).map(f => f.sha256).sort().join('|') === shaKey) return { outcome: 'unchanged', itemId: active.id }
      prevDir = path.join(queue.root, 'items', active.id, `v${active.version}`)
    }
    const itemId = active?.id ?? newItemId()
    const n = (active?.version ?? 0) + 1
    const vdir = path.join(queue.root, 'items', itemId, `v${n}`)
    fs.rmSync(vdir, { recursive: true, force: true })
    fs.mkdirSync(path.join(vdir, 'preview'), { recursive: true })
    let recorded = false
    try {
      const files = []
      const copyOf = new Map()
      for (const [src, s] of sources) {
        const dst = path.join(vdir, `${s.part}${s.ext}`)
        fs.copyFileSync(src, dst)
        const sha256 = await sha256File(dst)
        if (sha256 !== s.sha) throw new Error(`${s.file.fileName} đổi trong lúc chép (${src}) — chạy lại`)
        let preview = path.join(vdir, 'preview', `${s.part}.jpg`)
        try {
          await previewer(dst, preview)
        } catch (e) {
          log(`${s.line.taskKey}: không làm được ảnh xem trước ${s.file.fileName}: ${errText(e)}`)
          preview = null
        }
        files.push({ part: s.part, kind: s.file.kind, printArea: s.file.printArea, taskKey: s.line.taskKey, fileName: s.file.fileName, path: dst, sha256, preview, source: src })
        copyOf.set(src, dst)
      }
      const storedLines = lines.map(l => ({
        ...l,
        files: l.files.map(f => {
          if (!f.path) return f
          const { knownDriveFileId: _known, ...rest } = f
          return { ...rest, path: copyOf.get(path.resolve(f.path)) }
        }),
      }))
      const lead = infos[0]
      const image = async (url, name, prevUrl) => {
        if (!url) return null
        const dst = path.join(vdir, name)
        const old = prevDir && prevUrl === url ? path.join(prevDir, name) : null
        if (old && fs.existsSync(old)) { fs.copyFileSync(old, dst); return dst }
        try {
          await previewer(await download(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS }), dst)
          return dst
        } catch (e) {
          log(`${groupKey}: không tải được ảnh ${url} (${errText(e)}) — chỉ giữ đường link`)
          return null
        }
      }
      const meta = {
        ...lead,
        customerPreview: await image(lead.customerPreviewUrl, 'customer.jpg', active?.meta?.customerPreviewUrl),
        storeImage: await image(lead.storeImageUrl, 'store.jpg', active?.meta?.storeImageUrl),
        sourceCli: source.cli ?? null,
        spec: source.spec ?? null,
        ledgerPath: source.ledgerPath ?? null,
        out: source.out ?? null,
        mockup: mockups[0] ?? null,
      }
      if (lines.length > 1) meta.lines = infos.map((x, i) => ({ ...x, mockup: mockups[i] ?? null }))
      const qa = combineQa(lines.map(l => l.taskKey), qaByKey)
      for (const [i, m] of mockups.entries()) {
        if (m.state !== 'missing') continue
        qa.verdict = 'fail'
        qa.items.push(`${lines.length > 1 ? `${lines[i].taskKey}: ` : ''}${MOCKUP_MISSING}: ${m.reason}`)
      }
      const r = await queue.addOrUpdate({
        id: itemId, taskKey: groupKey, taskKeys, groupKey, kind: lines.length > 1 ? 'group' : 'line',
        apiLines: storedLines, files, meta, qa, refresh,
      })
      recorded = r.changed
      if (!r.changed) return { outcome: 'unchanged', itemId: r.itemId }
      if (r.itemId !== itemId || r.version !== n) log(`${groupKey}: hàng chờ ghi bản v${r.version} của ${r.itemId}, khác dự kiến v${n} của ${itemId} — kiểm tra thư mục ${vdir}`)
      return { outcome: 'enqueued', itemId: r.itemId, version: r.version, created: r.created, addedKeys: r.created ? [] : taskKeys.filter(k => !prevKeys.includes(k)) }
    } finally {
      if (!recorded) fs.rmSync(active ? vdir : path.dirname(vdir), { recursive: true, force: true })
    }
  }
}

function readQaJson(file) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`Không đọc được --qa-json ${file}: ${errText(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`--qa-json ${file} phải là object taskKey → { verdict, items }`)
  return parsed
}

/**
 * The `--via api --to-queue` branch of the push CLIs: enqueue what has something new to look at, print one line per key,
 * deliver the bypassed lines through the normal API path. `makeDeps` (client + uploader) is only called when needed.
 * @param {{
 *   plan: { lines: any[] }, storageRoot: string, outDir: string, snapshot: any, queueRoot?: string, sourceCli: string,
 *   spec?: string|null, qaJson?: string|null, makeDeps: () => { client: any, uploader: any }, makeNoteClient?: () => { note: Function },
 *   previewOf?: ((p: string) => Promise<Buffer|null>) | null, previewer?: (input: string|Buffer, dst: string) => Promise<any>,
 *   download?: (url: string, opts?: any) => Promise<Buffer>, log?: (m: string) => void,
 * }} opts
 * @returns {Promise<number>} exit code
 */
export async function runQueueIntake({
  plan, storageRoot, outDir, snapshot, queueRoot = queueRootFromEnv(), sourceCli, spec = null, qaJson = null,
  makeDeps, makeNoteClient: makeNotes = () => makeNoteClient(), previewOf = null, previewer = makePreview, download = downloadImage, log = console.log,
  mockup = resolveMockup, artworkBuilder = process.env.ARTWORK_BUILDER || DEFAULT_ARTWORK_BUILDER,
}) {
  const ledgerPath = path.join(outDir, 'api-ledger.json')
  const qaByKey = qaJson ? readQaJson(qaJson) : {}
  const { lines, skipped } = queueApiLines(plan, { storageRoot, ledgerPath })
  log(`\n== Hàng chờ duyệt local (${queueRoot}): ${lines.length} dòng ==`)
  let deps = null
  const getDeps = () => (deps ??= makeDeps())
  let notes = null
  let result = { enqueued: [], unchanged: [], bypassed: [], refused: [], reasons: {}, unnoted: [] }
  if (lines.length) {
    const queue = await openQueue({ root: queueRoot })
    try {
      result = await enqueuePlan({
        plan, apiLines: lines, queue, snapshot, qaByKey, previewer, download, log, mockup, artworkBuilder,
        client: { note: (k, m) => (notes ??= makeNotes()).note(k, m) },
        source: { cli: sourceCli, spec, out: outDir, ledgerPath },
      })
    } finally {
      await queue.close()
    }
  }
  const said = new Map()
  for (const k of result.enqueued) said.set(k, 'vào hàng chờ')
  for (const k of result.unchanged) said.set(k, `không đổi (${result.reasons[k] ?? 'đã có trong hàng chờ'})`)
  for (const k of result.bypassed) said.set(k, 'giao thẳng (chỉ dùng lại file đã có trên Drive)')
  for (const r of result.refused) said.set(r.taskKey, `không vào hàng chờ: ${r.reason}`)
  for (const l of lines) if (said.has(l.taskKey)) { log(`  ${l.taskKey}  ${said.get(l.taskKey)}`); said.delete(l.taskKey) }
  for (const s of skipped) log(`  ${s.taskKey}  ${s.waitingFor ? 'chờ' : 'không gửi'}: ${s.reason}`)
  log(`${lines.length} dòng · vào hàng chờ ${result.enqueued.length} · không đổi ${result.unchanged.length} · giao thẳng ${result.bypassed.length} · không vào được ${result.refused.length} · không gửi ${skipped.length}`)

  let code = result.refused.length ? 1 : 0
  if (result.bypassed.length) {
    const keep = new Set(result.bypassed)
    const r = await deliverPlanViaApi({ plan: { ...plan, lines: (plan.lines ?? []).filter(l => keep.has(l.taskKey)) }, storageRoot, ledgerPath, makeDeps: getDeps, previewOf, log })
    if (r.exitCode) code = r.exitCode
  }
  return code
}
