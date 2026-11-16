import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { openQueue, COUNTDOWN_MS, ALL_STATUSES } from './store.mjs'
import { DEFAULT_QUEUE_ROOT } from './intake.mjs'
import {
  TICK_BUDGET_MS, approveItem, rejectItem, sendToCloud, removeItem, loadEnvFiles, makeLiveDeps, queueEnvFiles,
} from './actions.mjs'
import { startFix, runFixJob, recoverFixJobs, listJobs, makeFixDeps } from './fix-job.mjs'

// The local review page (spec 7.3, 12.5, 13): http://127.0.0.1:3020, reads previews straight from the queue folder.
//   node scripts/review-queue/server.mjs
// Env as tick.mjs (prod.env, approve.env, auto render's config.env); REVIEW_QUEUE_ROOT, REVIEW_QUEUE_PORT (default 3020).
// Listens on 127.0.0.1 only. Every request must name this server in Host (DNS rebinding) and every POST must carry
// `X-Review-Queue: 1` (a page on another site cannot add it without a CORS preflight this server never answers).

export const DEFAULT_PORT = 3020
export const HOST = '127.0.0.1'
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')
const ITEM_ID = /^rq_[A-Za-z0-9]{1,40}$/
const COUNTING = ['waiting', 'qa_failed']
const DONE = ['approved', 'cloud', 'held', 'removed']
const DONE_LIMIT = 200
const BODY_MAX = 64 * 1024
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css' }
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.pdf': 'application/pdf', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
}
const STATUS_OF_CODE = { not_found: 404, bad_request: 400, version_required: 400 }
const CSP = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'"
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP }

const errText = e => (e instanceof Error ? e.message : String(e))

function send(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers })
  res.end(buf)
}
const fail = (res, status, error, extra = {}) => send(res, status, { ok: false, error, ...extra })

function hostAllowed(req) {
  const port = req.socket.localPort
  const host = String(req.headers.host ?? '').toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

function originAllowed(req) {
  const origin = req.headers.origin
  if (origin == null) return true
  const port = req.socket.localPort
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', c => {
      if (tooBig) return
      size += c.length
      if (size > BODY_MAX) {
        tooBig = true
        chunks.length = 0
        reject(Object.assign(new Error('body quá lớn'), { status: 413 }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooBig) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        const v = JSON.parse(text)
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
        resolve(v)
      } catch {
        reject(Object.assign(new Error('JSON không hợp lệ'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

const versionDir = (root, itemId, n) => path.join(root, 'items', itemId, `v${n}`)

/** `/files/<id>/v/<n>/<rel>` for a path inside that version folder, else null. */
function fileUrl(root, itemId, n, p) {
  if (!p) return null
  const dir = versionDir(root, itemId, n)
  const rel = path.relative(dir, path.resolve(p))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return `/files/${itemId}/v/${n}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`
}

const deadlineOf = item => (COUNTING.includes(item.status) ? new Date(Date.parse(item.enteredAt) + COUNTDOWN_MS).toISOString() : null)
const localDay = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** The command that re-queues an item from a fresh snapshot (needs_look, spec 12.5); the page only shows it. */
export function rerunCommand(item) {
  const m = item.meta ?? {}
  if (m.sourceCli === 'push-shared-prints') {
    return `node scripts/push-shared-prints.mjs --via api --to-queue${m.spec ? ` --spec "${m.spec}"` : ''}`
  }
  return `node scripts/push-local-renders.mjs --via api --to-queue --line ${item.taskKey}${m.out ? ` --out "${m.out}"` : ''}`
}

async function imageSize(p) {
  try {
    const { default: sharp } = await import('sharp')
    const m = await sharp(p).metadata()
    return m.width && m.height ? { width: m.width, height: m.height } : null
  } catch {
    return null
  }
}

/**
 * The review server's request handler. `ops` replaces the queue actions (tests); `deps` go to approve/cloud, `fixDeps` to fix jobs.
 * @param {{ queue: any, deps: any, fixDeps?: any, ops?: Record<string, Function>, now?: () => Date, log?: (m: string) => void, publicDir?: string }} opts
 */
export function createHandler({ queue, deps, fixDeps = {}, ops = {}, now = () => new Date(), log = console.log, publicDir = PUBLIC_DIR }) {
  const act = { approveItem, rejectItem, sendToCloud, removeItem, startFix, runFixJob, ...ops }
  const root = queue.root

  async function summary(item) {
    const cur = (await queue.versions(item.id)).find(v => v.n === item.version)
    const files = cur?.files ?? []
    const thumbFile = files.find(f => f.preview && f.kind === 'PRINT') ?? files.find(f => f.preview)
    const m = item.meta ?? {}
    return {
      id: item.id, taskKey: item.taskKey, groupKey: item.groupKey, kind: item.kind, status: item.status, statusReason: item.statusReason,
      version: item.version, enteredAt: item.enteredAt, updatedAt: item.updatedAt, deadline: deadlineOf(item),
      qa: { verdict: item.qa?.verdict ?? 'unchecked', count: item.qa?.items?.length ?? 0, ...(item.qa?.items?.length ? { items: item.qa.items } : {}) },
      title: m.productTitle ?? '', variant: m.variantTitle ?? null, orderNumber: m.orderNumber ?? null,
      thumb: thumbFile ? fileUrl(root, item.id, item.version, thumbFile.preview) : null,
    }
  }

  async function listItems(url) {
    const wanted = (url.searchParams.get('status') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const bad = wanted.find(s => !ALL_STATUSES.includes(s))
    if (bad) return { status: 400, body: { ok: false, error: `Trạng thái không hợp lệ: ${bad}` } }
    const all = await queue.list()
    const counts = Object.fromEntries(ALL_STATUSES.map(s => [s, 0]))
    for (const i of all) counts[i.status] = (counts[i.status] ?? 0) + 1
    const today = localDay(now())
    const approvedToday = all.filter(i => i.status === 'approved' && localDay(new Date(i.updatedAt)) === today).length
    const picked = wanted.length ? all.filter(i => wanted.includes(i.status)) : all
    const done = picked.filter(i => DONE.includes(i.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, DONE_LIMIT)
    const items = [...picked.filter(i => !DONE.includes(i.status)), ...done]
    const out = []
    for (const i of items) out.push(await summary(i))
    return { status: 200, body: { items: out, counts, approvedToday, now: now().toISOString() } }
  }

  async function detail(item) {
    const versions = await queue.versions(item.id)
    const vs = []
    for (const v of versions) {
      const files = []
      for (const f of v.files ?? []) {
        let bytes = null
        try { bytes = fs.statSync(f.path).size } catch { /* the original may have been cleaned */ }
        const size = v.n === item.version && bytes != null ? await imageSize(f.path) : null
        files.push({
          part: f.part, kind: f.kind, printArea: f.printArea ?? null, taskKey: f.taskKey ?? null, fileName: f.fileName ?? path.basename(f.path ?? ''),
          url: fileUrl(root, item.id, v.n, f.path), previewUrl: fileUrl(root, item.id, v.n, f.preview), bytes, ...(size ?? {}),
        })
      }
      vs.push({ n: v.n, createdAt: v.createdAt, qa: v.qa, files })
    }
    const vdir = versionDir(root, item.id, item.version)
    const m = item.meta ?? {}
    const image = (name, remote) => {
      const local = path.join(vdir, name)
      if (fs.existsSync(local)) return { url: fileUrl(root, item.id, item.version, local), original: remote ?? fileUrl(root, item.id, item.version, local) }
      return remote ? { url: remote, original: remote } : null
    }
    const jobs = listJobs(queue, item.id).map(j => ({
      id: j.id, n: j.n, agent: j.agent, reason: j.reason ?? '', status: j.status, version: j.version ?? null,
      createdAt: j.createdAt ?? null, finishedAt: j.finishedAt ?? null, message: j.message ?? null, resultVersion: j.resultVersion ?? null,
    }))
    return {
      item: { ...(await summary(item)), meta: m, qa: item.qa, prevStatus: item.prevStatus, createdAt: item.createdAt },
      memberKeys: await queue.memberKeys(item.id),
      versions: vs,
      images: { customer: image('customer.jpg', m.customerPreviewUrl ?? null), store: image('store.jpg', m.storeImageUrl ?? null) },
      events: await queue.events(item.id),
      jobs,
      rerun: item.status === 'needs_look' ? rerunCommand(item) : null,
      now: now().toISOString(),
    }
  }

  function serveFile(res, parts) {
    const [id, v, n, ...rest] = parts
    if (!ITEM_ID.test(id ?? '') || v !== 'v' || !/^[1-9]\d{0,5}$/.test(n ?? '') || !rest.length) return fail(res, 404, 'Không có file')
    let segs
    try {
      segs = rest.map(s => decodeURIComponent(s))
    } catch {
      return fail(res, 400, 'Đường dẫn không hợp lệ')
    }
    if (segs.some(s => /^[\s.]*$/.test(s) || /[\\/:\0]/.test(s))) return fail(res, 403, 'Đường dẫn ngoài thư mục dòng')
    const dir = versionDir(root, id, Number(n))
    const target = path.resolve(dir, ...segs)
    if (!target.startsWith(dir + path.sep)) return fail(res, 403, 'Đường dẫn ngoài thư mục dòng')
    let real
    let realDir
    let st
    try {
      real = fs.realpathSync(target)
      realDir = fs.realpathSync(dir)
      st = fs.statSync(real)
    } catch {
      return fail(res, 404, 'Không có file')
    }
    if (!real.startsWith(realDir + path.sep)) return fail(res, 403, 'Đường dẫn ngoài thư mục dòng')
    if (!st.isFile()) return fail(res, 404, 'Không có file')
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'private, max-age=300', ...SECURITY_HEADERS,
    })
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res)
  }

  function serveStatic(res, name) {
    const p = path.join(publicDir, name)
    let buf
    try {
      buf = fs.readFileSync(p)
    } catch {
      return fail(res, 404, 'Không có trang')
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)], 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS })
    res.end(buf)
  }

  async function runAction(action, item, body) {
    const id = item.id
    const version = body.version
    switch (action) {
      case 'approve':
        return act.approveItem(queue, id, deps, { force: body.force === true, version })
      case 'cloud':
        return act.sendToCloud(queue, id, deps, { force: body.force === true, version: Number.isInteger(version) ? version : null })
      case 'reject':
        return act.rejectItem(queue, id, typeof body.reason === 'string' ? body.reason : '', { version: Number.isInteger(version) ? version : null })
      case 'remove':
        return act.removeItem(queue, id, { version: Number.isInteger(version) ? version : null })
      case 'fix': {
        const r = await act.startFix(queue, id, { agent: body.agent, reason: typeof body.reason === 'string' ? body.reason : '', version }, fixDeps)
        if (r?.ok && r.jobId) {
          try {
            Promise.resolve(act.runFixJob(queue, r.jobId, fixDeps))
              .then(x => log(`${item.taskKey}: job ${r.jobId} ${x?.ok ? `xong → v${x.version} (${x.status})` : `không xong: ${x?.error ?? '?'}`}`))
              .catch(e => log(`${item.taskKey}: job ${r.jobId} lỗi: ${errText(e)}`))
          } catch (e) {
            log(`${item.taskKey}: không chạy được job ${r.jobId}: ${errText(e)}`)
          }
        }
        return r
      }
      default:
        return null
    }
  }

  return async function handler(req, res) {
    try {
      if (!hostAllowed(req)) return fail(res, 403, 'Host không hợp lệ')
      const url = new URL(req.url ?? '/', 'http://local')
      const rawPath = (req.url ?? '/').split('?')[0]
      const parts = rawPath.split('/').slice(1)

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (STATIC[rawPath]) return serveStatic(res, STATIC[rawPath])
        if (parts[0] === 'files') return serveFile(res, parts.slice(1))
        if (rawPath === '/api/items') {
          const r = await listItems(url)
          return send(res, r.status, r.body)
        }
        if (parts[0] === 'api' && parts[1] === 'items' && parts.length === 3) {
          const id = parts[2]
          const item = ITEM_ID.test(id) ? await queue.get(id) : null
          if (!item) return fail(res, 404, `Không có dòng ${id}`)
          return send(res, 200, await detail(item))
        }
        return fail(res, 404, 'Không có trang')
      }

      if (req.method === 'POST') {
        if (req.headers['x-review-queue'] !== '1' || !originAllowed(req)) return fail(res, 403, 'Thiếu header X-Review-Queue hoặc sai nguồn')
        const m = /^\/api\/items\/([^/]+)\/(approve|reject|cloud|remove|fix)$/.exec(rawPath)
        if (!m) return fail(res, 404, 'Không có thao tác này')
        const [, id, action] = m
        const item = ITEM_ID.test(id) ? await queue.get(id) : null
        if (!item) return fail(res, 404, `Không có dòng ${id}`, { code: 'not_found' })
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return fail(res, e?.status ?? 400, errText(e), { code: 'bad_request' })
        }
        const r = await runAction(action, item, body)
        log(`${action} ${item.taskKey} (${id}): ${r?.ok ? `ok → ${r.status}` : `${r?.code ?? '?'} ${r?.error ?? ''}`}`)
        if (!r) return fail(res, 500, 'Không có kết quả')
        return send(res, r.ok ? 200 : STATUS_OF_CODE[r.code] ?? 409, r)
      }

      return fail(res, 405, 'Method không hỗ trợ')
    } catch (e) {
      log(`LỖI ${req.method} ${req.url}: ${errText(e)}`)
      if (res.headersSent) return res.destroy()
      return fail(res, 500, errText(e))
    }
  }
}

/** An http.Server (not listening yet) around createHandler. */
export function createReviewServer(opts) {
  return http.createServer(createHandler(opts))
}

/**
 * Entry: env files like the tick, one queue object for the process, fix jobs left by an earlier run recovered once, then listen.
 * @param {{ env?: Record<string, string|undefined>, log?: (m: string) => void, deps?: any, fixDeps?: any, ops?: any }} [opts]
 */
export async function main({ env = process.env, log = console.log, deps = null, fixDeps = null, ops = {} } = {}) {
  loadEnvFiles(queueEnvFiles(env), env)
  const root = env.REVIEW_QUEUE_ROOT || DEFAULT_QUEUE_ROOT
  const port = Number(env.REVIEW_QUEUE_PORT || DEFAULT_PORT)
  const queue = await openQueue({ root })
  const recovered = await recoverFixJobs(queue, { log })
  if (recovered.length) log(`Đã gỡ ${recovered.length} job agent bị gián đoạn`)
  const server = createReviewServer({
    queue, ops, log,
    deps: deps ?? makeLiveDeps({ env, log, budgetMs: TICK_BUDGET_MS }),
    fixDeps: fixDeps ?? makeFixDeps({ env, log }),
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => resolve(undefined))
  })
  log(`Duyệt local: http://${HOST}:${port}  (hàng chờ ${root})`)
  const stop = () => server.close(() => queue.close().finally(() => process.exit(0)))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return { server, queue, port }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(`LỖI: ${errText(e)}`)
    process.exit(1)
  })
}
