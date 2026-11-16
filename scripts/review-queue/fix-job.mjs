import fs from 'fs'
import path from 'path'
import { spawn as nodeSpawn, execFile } from 'child_process'
import { makePreview, sha256File } from './intake.mjs'
import { underLocks } from './actions.mjs'

// Gọi Agent sửa (spec 6, 7.5, 12.7, 13): a queued item is copied into items/<id>/jobs/<n>/ (BRIEF.md, in\, ref\, out\) and
// handed to Claude (headless) or Codex (desktop exec) with the job folder as its only workspace and no token in its environment.
// What the agent leaves in out\ (same file names as in\) becomes the item's next version for the owner to review again; a
// failure, a timeout or a write anywhere else puts the item back to the status it had.

export const FIX_LIMIT_MS = 60 * 60_000
export const FIX_PROMPT = 'Đọc BRIEF.md và làm đúng như trong đó.'
export const FIX_FAILED = 'agent không sửa được'
const FAILED_STATUS = 'rejected'
export const FIXABLE_STATUSES = ['waiting', 'rejected', 'qa_failed', 'needs_look']
export const AGENTS = ['claude', 'codex']
export const CHILD_ENV_KEYS = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]
const CHILD_ENV_EXTRA = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DISABLE_AUTOUPDATER: '1' }
const CLAUDE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']
const MESSAGE_MAX = 500
const CLOSE_WAIT_MS = 5_000
const KILL_GRACE_MS = 30_000
const LOCK_TRIES = 30
const LOCK_RETRY_MS = 2_000
const JOB_ID = /^(rq_[A-Za-z0-9]{1,40})-(\d{1,6})$/
const REF_IMAGES = [['customerPreview', 'customer'], ['storeImage', 'store']]
const META_REFS = [['spec', 'Spec (flat-text / shared prints)'], ['template', 'Template xưởng'], ['templatePath', 'Template xưởng'], ['designRules', 'Design rules'], ['flatTextSpec', 'Spec flat-text']]

const errText = e => (e instanceof Error ? e.message : String(e))
const fail = (itemId, code, error, extra = {}) => ({ ok: false, itemId, code, error, ...extra })
const clip = (s, n = MESSAGE_MAX) => (s.length > n ? s.slice(0, n) : s)
const isFile = p => { try { return fs.statSync(p).isFile() } catch { return false } }
const readdir = d => { try { return fs.readdirSync(d, { withFileTypes: true }) } catch { return [] } }
const defaultQa = async () => ({ verdict: 'unchecked', items: [] })
const ownJobs = new Set()

/**
 * The job's environment: only the listed system variables (whatever their case in `env`) plus UTF-8 Python and no auto-update.
 * @param {Record<string, string|undefined>} [env]
 */
export function childEnv(env = process.env) {
  const byUpper = new Map(Object.keys(env).map(k => [k.toUpperCase(), k]))
  const out = {}
  for (const k of CHILD_ENV_KEYS) {
    const src = byUpper.get(k)
    if (src && env[src] != null) out[k] = String(env[src])
  }
  return { ...out, ...CHILD_ENV_EXTRA }
}

/**
 * Newest %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe, or null.
 * @param {Record<string, string|undefined>} [env]
 */
export function findCodexExe(env = process.env) {
  if (!env.LOCALAPPDATA) return null
  const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
  let best = null
  for (const d of readdir(bin)) {
    if (!d.isDirectory()) continue
    const exe = path.join(bin, d.name, 'codex.exe')
    try {
      const st = fs.statSync(exe)
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { exe, mtimeMs: st.mtimeMs }
    } catch { /* no codex.exe in this folder */ }
  }
  return best?.exe ?? null
}

/**
 * %USERPROFILE%\.local\bin\claude.exe, else `claude` on PATH.
 * @param {Record<string, string|undefined>} [env]
 */
export function findClaudeExe(env = process.env) {
  const exe = env.USERPROFILE ? path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe') : null
  return exe && isFile(exe) ? exe : 'claude'
}

function claudeHelpText(exe) {
  return new Promise((resolve, reject) => {
    execFile(exe, ['--help'], { env: childEnv(), timeout: 30_000, windowsHide: true, maxBuffer: 4 << 20 }, (e, stdout, stderr) => {
      if (e && !stdout) reject(e)
      else resolve(`${stdout}\n${stderr}`)
    })
  })
}

const strictMcp = new Map()
function claudeHasStrictMcp(exe, help) {
  if (!strictMcp.has(exe)) {
    const p = Promise.resolve().then(() => help(exe)).then(t => /--strict-mcp-config\b/.test(String(t)))
    // a failed --help is asked again next time instead of being cached as "no flag"
    strictMcp.set(exe, p.catch(() => { strictMcp.delete(exe); return false }))
  }
  return strictMcp.get(exe)
}

/**
 * The top-level `model = "…"` of %USERPROFILE%\.codex\config.toml (lines before the first [table]), or null.
 * @param {Record<string, string|undefined>} [env]
 */
export function codexConfigModel(env = process.env) {
  const file = env.USERPROFILE ? path.join(env.USERPROFILE, '.codex', 'config.toml') : null
  if (!file || !isFile(file)) return null
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) break
    const m = /^model\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line)
    if (m) return (m[1] ?? m[2]) || null
  }
  return null
}

/**
 * The command line of one agent run in `jobDir`.
 * Codex: exec --ignore-user-config [-m <model>] -C <job> --skip-git-repo-check --sandbox workspace-write -o <job>\last-message.txt <prompt>
 * (the owner's config.toml carries MCP servers, plugins and hooks; only its model is kept, `deps.codexModel` overrides).
 * Claude: -p <prompt> --output-format json --permission-mode dontAsk --allowedTools … --add-dir <job> [--strict-mcp-config], no --mcp-config.
 */
export async function agentCommand(agent, jobDir, deps = {}) {
  if (agent === 'codex') {
    const exe = deps.codexExe ?? findCodexExe(deps.env ?? process.env)
    if (!exe) throw new Error('không thấy codex.exe trong %LOCALAPPDATA%\\OpenAI\\Codex\\bin')
    const model = 'codexModel' in deps ? deps.codexModel : codexConfigModel(deps.env ?? process.env)
    return {
      cmd: exe,
      args: ['exec', '--ignore-user-config', ...(model ? ['-m', model] : []), '-C', jobDir, '--skip-git-repo-check', '--sandbox', 'workspace-write', '-o', path.join(jobDir, 'last-message.txt'), FIX_PROMPT],
    }
  }
  if (agent !== 'claude') throw new Error(`agent không hợp lệ: ${agent}`)
  const exe = deps.claudeExe ?? findClaudeExe(deps.env ?? process.env)
  // Bash stays allowed because image fixes need python; it is not confined to the job folder (accepted risk, controller ruling 11/16)
  const args = ['-p', FIX_PROMPT, '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', ...CLAUDE_TOOLS, '--add-dir', jobDir]
  if (await claudeHasStrictMcp(exe, deps.claudeHelp ?? claudeHelpText)) args.push('--strict-mcp-config')
  return { cmd: exe, args }
}

const itemDir = (queue, itemId) => path.join(queue.root, 'items', itemId)
export const jobIdOf = (itemId, n) => `${itemId}-${n}`
const parseJobId = jobId => {
  const m = JOB_ID.exec(String(jobId ?? ''))
  return m ? { itemId: m[1], n: Number(m[2]) } : null
}

export function jobDirOf(queue, jobId) {
  const ref = parseJobId(jobId)
  return ref ? path.join(itemDir(queue, ref.itemId), 'jobs', String(ref.n)) : null
}

/** job.json of a job, or null. */
export function readJob(queue, jobId) {
  const dir = jobDirOf(queue, jobId)
  if (!dir) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Every job of an item, oldest first. */
export function listJobs(queue, itemId) {
  return readdir(path.join(itemDir(queue, itemId), 'jobs'))
    .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
    .map(d => readJob(queue, jobIdOf(itemId, d.name)))
    .filter(Boolean)
    .sort((a, b) => a.n - b.n)
}

function writeJob(dir, job) {
  const file = path.join(dir, 'job.json')
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 2))
  fs.renameSync(`${file}.tmp`, file)
  return job
}

async function readImageSize(p) {
  try {
    const { default: sharp } = await import('sharp')
    const m = await sharp(p, { limitInputPixels: false }).metadata()
    return m.width && m.height ? { width: m.width, height: m.height, space: m.space ?? null } : null
  } catch {
    return null
  }
}

const usDate = v => {
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }) : null
}

function briefText({ item, keys, agent, reason, inFiles, refs, metaRefs }) {
  const m = item.meta ?? {}
  const L = []
  L.push(`# Sửa file in — ${item.taskKey} (bản v${item.version})`, '')
  L.push('Bạn sửa file in cho một dòng đơn POD. Đọc hết file này rồi làm đúng như dưới đây.', '')
  L.push('## Dòng đơn')
  L.push(`- Task: ${item.taskKey}${keys.length > 1 ? ` (nhóm dùng chung file: ${keys.join(', ')})` : ''}`)
  L.push(`- Sản phẩm: ${m.productTitle || '?'}${m.variantTitle ? ` — ${m.variantTitle}` : ''}`)
  if (m.sku || m.supplierSku) L.push(`- SKU: ${m.sku ?? '?'} · SKU xưởng: ${m.supplierSku ?? '?'}`)
  if (m.orderNumber) L.push(`- Đơn: ${m.orderNumber}${usDate(m.placedAt) ? ` (đặt ${usDate(m.placedAt)})` : ''}`)
  const custom = Array.isArray(m.custom) ? m.custom : []
  L.push(`- Custom của khách:${custom.length ? '' : ' không có'}`)
  for (const c of custom) L.push(`  - ${c.name}: ${c.value}`)
  L.push('', '## Chủ shop muốn sửa', reason || '(không ghi lý do — sửa theo lỗi kiểm tra máy bên dưới)', '')
  const qaItems = item.qa?.items ?? []
  L.push(`## Lỗi kiểm tra máy (QA) của bản v${item.version}`)
  if (qaItems.length) for (const i of qaItems) L.push(`- ${i}`)
  else L.push('- Không có')
  L.push('', '## File cần sửa (thư mục in\\)', '', '| File | Phần | Task | Kích thước |', '|---|---|---|---|')
  for (const f of inFiles) {
    const size = f.size ? `${f.size.width}x${f.size.height} px${f.size.space ? `, ${f.size.space}` : ''}` : 'không đọc được'
    L.push(`| in\\${f.name} | ${[f.kind, f.printArea].filter(Boolean).join(' ')} | ${f.taskKey ?? item.taskKey} | ${size} |`)
  }
  L.push('', '## Tham khảo (chỉ đọc)')
  if (!refs.length && !metaRefs.length) L.push('- Không có')
  for (const r of refs) L.push(`- ${r.label}: ref\\${r.name}`)
  for (const r of metaRefs) L.push(`- ${r.label}: ${r.path}`)
  L.push('', '## Quy tắc')
  L.push('- Chỉ ghi kết quả vào out\\, đúng tên file như trong in\\ (ví dụ out\\' + (inFiles[0]?.name ?? 'PRINT_Front.png') + '). Mỗi file trong in\\ phải có một file cùng tên trong out\\.')
  L.push('- Giữ nguyên kích thước pixel và hệ màu (RGB/CMYK) của từng file.')
  L.push('- Không sửa hay xoá file trong in\\ và ref\\.')
  L.push('- Không đọc hay ghi ở ngoài thư mục này, trừ các đường dẫn tham khảo chỉ đọc ở trên. Không đụng NAS, thư viện, prod.')
  L.push('- Không upload hay gửi gì lên mạng.')
  L.push('- Viết out\\NOTES.md ngắn (tiếng Việt): đã sửa gì, phần nào giữ nguyên.')
  L.push('- Nếu không sửa được thì không ghi file in nào vào out\\, chỉ ghi lý do vào out\\NOTES.md.')
  L.push('', `Agent: ${agent}.`, '')
  return L.join('\r\n')
}

/**
 * Gọi Agent sửa: makes the job folder of the current version and sets the item `fixing`. Run it with runFixJob.
 * `version` is the version the owner looked at (required). Allowed from waiting, rejected, qa_failed and needs_look.
 * @param {any} queue @param {string} itemId
 * @param {{ agent: string, reason?: string, version?: number }} opts
 * @param {{ now?: () => Date, imageSize?: (p: string) => Promise<{ width: number, height: number, space?: string|null }|null> }} [deps]
 * @returns {Promise<any>} { ok:true, itemId, jobId, jobDir, status:'fixing' } or { ok:false, itemId, code, error, status?, version? }
 */
export async function startFix(queue, itemId, { agent, reason, version } = /** @type {any} */ ({}), deps = {}) {
  if (!AGENTS.includes(agent)) return fail(itemId, 'bad_request', 'Agent phải là claude hoặc codex')
  if (!Number.isInteger(version)) return fail(itemId, 'version_required', 'Gọi Agent sửa cần số bản đang xem (version)')
  const why = typeof reason === 'string' ? reason.trim() : ''
  const now = deps.now ?? (() => new Date())
  const imageSize = deps.imageSize ?? readImageSize
  return underLocks(queue, itemId, async () => {
    const item = await queue.get(itemId)
    if (item.version !== version) {
      return fail(itemId, 'version_changed', `Dòng đã có bản mới v${item.version} (trang đang xem v${version}) — xem lại rồi bấm lại`, { status: item.status, version: item.version })
    }
    if (!FIXABLE_STATUSES.includes(item.status)) return fail(itemId, 'not_fixable', `Dòng đang ${item.status} — không gọi agent sửa được`, { status: item.status })
    if (!why && !(item.qa?.items ?? []).length) return fail(itemId, 'bad_request', 'Cần lý do sửa (hoặc lỗi QA để agent sửa theo)')
    const cur = (await queue.versions(itemId)).find(v => v.n === item.version)
    const files = (cur?.files ?? []).filter(f => f.path)
    if (!files.length) return fail(itemId, 'no_files', `Bản v${item.version} không có file để sửa`)
    const jobsDir = path.join(itemDir(queue, itemId), 'jobs')
    const n = Math.max(0, ...readdir(jobsDir).filter(d => /^\d+$/.test(d.name)).map(d => Number(d.name))) + 1
    const dir = path.join(jobsDir, String(n))
    const jobId = jobIdOf(itemId, n)
    try {
      for (const sub of ['in', 'out', 'ref']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
      const inFiles = []
      for (const f of files) {
        const name = path.basename(f.path)
        if (!isFile(f.path)) throw new Error(`không thấy file của bản v${item.version}: ${f.path}`)
        fs.copyFileSync(f.path, path.join(dir, 'in', name))
        inFiles.push({ name, kind: f.kind, printArea: f.printArea, taskKey: f.taskKey, size: await imageSize(path.join(dir, 'in', name)) })
      }
      const refs = []
      for (const [field, base] of REF_IMAGES) {
        const src = item.meta?.[field]
        if (!src || !isFile(src)) continue
        const name = `${base}${path.extname(src) || '.jpg'}`
        fs.copyFileSync(src, path.join(dir, 'ref', name))
        refs.push({ name, label: field === 'customerPreview' ? 'Ảnh khách xem trước lúc đặt' : 'Ảnh sản phẩm trên store' })
      }
      const seen = new Set()
      const metaRefs = META_REFS.filter(([k]) => typeof item.meta?.[k] === 'string' && item.meta[k] && !seen.has(item.meta[k]) && seen.add(item.meta[k]))
        .map(([k, label]) => ({ label, path: item.meta[k] }))
      const keys = await queue.memberKeys(itemId)
      fs.writeFileSync(path.join(dir, 'BRIEF.md'), briefText({ item, keys, agent, reason: why, inFiles, refs, metaRefs }))
      writeJob(dir, {
        id: jobId, itemId, n, agent, reason: why, version: item.version, status: 'queued',
        parts: inFiles.map(f => f.name), createdAt: now().toISOString(),
      })
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      return fail(itemId, 'error', `Không tạo được job: ${errText(e)}`, { status: item.status })
    }
    ownJobs.add(jobId)
    try {
      await queue.setStatus(itemId, 'fixing', { reason: `Agent ${agent} đang sửa (job ${n})` })
    } catch (e) {
      ownJobs.delete(jobId)
      fs.rmSync(dir, { recursive: true, force: true })
      return fail(itemId, 'error', `Không chuyển được sang đang sửa: ${errText(e)}`, { status: item.status })
    }
    await queue.addEvent(itemId, 'fix', `Gọi Agent sửa: ${agent} (job ${n}, bản v${item.version}) — ${why || 'theo lỗi QA'}`)
    return { ok: true, itemId, jobId, jobDir: dir, status: 'fixing' }
  })
}

function walk(dir, into) {
  for (const d of readdir(dir)) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walk(p, into)
    else if (d.isFile()) {
      try {
        const st = fs.statSync(p)
        into.set(p, `${st.size}:${st.mtimeMs}`)
      } catch { /* gone meanwhile: shows up as a change */ }
    }
  }
}

/** Files the agent must not touch: this item's versions, in\ and ref\ (any change), and other items' existing version files. */
function snapshot(queue, itemId, jobDir) {
  const mine = new Map()
  const others = new Map()
  const items = path.join(queue.root, 'items')
  for (const it of readdir(items)) {
    if (!it.isDirectory()) continue
    for (const v of readdir(path.join(items, it.name))) {
      if (v.isDirectory() && /^v\d+$/.test(v.name)) walk(path.join(items, it.name, v.name), it.name === itemId ? mine : others)
    }
  }
  walk(path.join(jobDir, 'in'), mine)
  walk(path.join(jobDir, 'ref'), mine)
  return { mine, others }
}

function changedSince(before, after, root) {
  const out = new Set()
  for (const [p, s] of before.mine) if (after.mine.get(p) !== s) out.add(p)
  for (const p of after.mine.keys()) if (!before.mine.has(p)) out.add(p)
  // other items may get new versions from intake meanwhile; only their existing files count
  for (const [p, s] of before.others) if (after.others.get(p) !== s) out.add(p)
  return [...out].map(p => path.relative(root, p))
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else child.kill('SIGKILL')
}

function runAgent({ cmd, args }, dir, deps) {
  const spawn = deps.spawn ?? nodeSpawn
  const kill = deps.killTree ?? (deps.spawn ? c => c.kill() : killTree)
  const limit = deps.limitMs ?? FIX_LIMIT_MS
  return new Promise(resolve => {
    const outFile = fs.createWriteStream(path.join(dir, 'stdout.txt'))
    const errFile = fs.createWriteStream(path.join(dir, 'stderr.txt'))
    let stdout = ''
    let stderr = ''
    let done = false
    let timedOut = false
    let exitInfo = null
    const timers = []
    const finish = r => {
      if (done) return
      done = true
      for (const t of timers) clearTimeout(t)
      outFile.end()
      errFile.end()
      resolve({ ...exitInfo, ...r, timedOut, stdout, stderr })
    }
    let child
    try {
      child = spawn(cmd, args, { cwd: dir, env: childEnv(deps.env ?? process.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      finish({ error: errText(e) })
      return
    }
    deps.onSpawn?.(child)
    child.stdout?.on('data', d => { if (done) return; outFile.write(d); stdout = (stdout + d).slice(-(1 << 20)) })
    child.stderr?.on('data', d => { if (done) return; errFile.write(d); stderr = (stderr + d).slice(-4000) })
    child.on('error', e => finish({ error: errText(e) }))
    child.on('exit', (code, signal) => {
      exitInfo = { exitCode: code, signal }
      // a grandchild can keep the pipes open after the agent itself exited
      timers.push(setTimeout(() => finish({}), CLOSE_WAIT_MS))
    })
    child.on('close', (code, signal) => finish(exitInfo ?? { exitCode: code, signal }))
    timers.push(setTimeout(() => {
      timedOut = true
      try { kill(child) } catch { /* already gone */ }
      timers.push(setTimeout(() => finish({}), KILL_GRACE_MS))
    }, limit))
  })
}

function claudeResult(stdout) {
  const text = String(stdout ?? '').trim()
  for (const cand of [text, text.split(/\r?\n/).filter(Boolean).pop() ?? '']) {
    try {
      const j = JSON.parse(cand)
      if (j && typeof j.result === 'string') return j.result
    } catch { /* not JSON */ }
  }
  return null
}

function lastMessage(agent, dir, run) {
  const file = path.join(dir, 'last-message.txt')
  if (agent === 'claude') {
    const r = claudeResult(run.stdout)
    if (r != null) fs.writeFileSync(file, r)
  }
  const txt = isFile(file) ? fs.readFileSync(file, 'utf8').trim() : ''
  const streams = agent === 'codex' ? [run.stdout, run.stderr] : [run.stderr, run.stdout]
  return txt || streams.map(x => tail(String(x ?? '').trim())).find(Boolean) || (run.exitCode != null ? `thoát mã ${run.exitCode}` : '')
}

const tail = (s, n = MESSAGE_MAX) => (s.length > n ? s.slice(-n) : s)

async function checkOut(dir, parts, imageSize) {
  const problems = []
  for (const name of parts) {
    const src = path.join(dir, 'in', name)
    const out = path.join(dir, 'out', name)
    if (!isFile(out) || fs.statSync(out).size === 0) { problems.push(`thiếu out\\${name}`); continue }
    const a = await imageSize(src)
    if (!a) continue
    const b = await imageSize(out)
    if (!b) problems.push(`out\\${name} không đọc được như ảnh`)
    else if (a.width !== b.width || a.height !== b.height) problems.push(`out\\${name} ${b.width}x${b.height} px, bản gốc ${a.width}x${a.height} px`)
    else if (a.space && b.space && a.space !== b.space) problems.push(`out\\${name} hệ màu ${b.space}, bản gốc ${a.space}`)
  }
  return problems
}

function normQa(qa) {
  return {
    verdict: ['pass', 'fail', 'unchecked'].includes(qa?.verdict) ? qa.verdict : 'unchecked',
    items: Array.isArray(qa?.items) ? qa.items.map(String) : [],
  }
}

/** A failed fix never counts down (spec 7.5): the item goes to rejected whatever it was before. */
async function failJob(queue, item, dir, job, problems, last, deps, extra = {}) {
  const now = deps.now ?? (() => new Date())
  const notesFile = path.join(dir, 'out', 'NOTES.md')
  const notes = isFile(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : ''
  const message = `${FIX_FAILED}: ${clip(notes || last || problems.join('; '))}`
  writeJob(dir, { ...job, ...extra, status: 'failed', finishedAt: now().toISOString(), message, problems })
  const cur = await queue.get(item.id)
  if ((notes || last) && problems.length) await queue.addEvent(item.id, 'fix_check', `Job ${job.n}: ${problems.join('; ')}`)
  if (cur?.status === 'fixing') await queue.setStatus(item.id, FAILED_STATUS, { reason: message })
  await queue.addEvent(item.id, 'fix_failed', message)
  return fail(item.id, 'fix_failed', message, { status: cur?.status === 'fixing' ? FAILED_STATUS : cur?.status, problems, jobId: job.id })
}

async function withLocksRetry(queue, itemId, fn, deps) {
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  for (let i = 1; ; i++) {
    const r = await underLocks(queue, itemId, fn)
    if (r?.code !== 'locked' || i >= LOCK_TRIES) return r
    await sleep(LOCK_RETRY_MS)
  }
}

/**
 * Stages out\ in the job folder with previews and machine QA outside the locks (QA can be slow), then under the item and intake
 * locks copies the staged files into v<n+1> and records them with addOrUpdate (same path as intake).
 */
async function recordVersion(queue, itemId, dir, job, last, deps) {
  const previewer = deps.previewer ?? makePreview
  const qaItem = deps.qaItem ?? defaultQa
  const baseFiles = (await queue.versions(itemId)).find(v => v.n === job.version)?.files ?? []
  const stage = path.join(dir, 'stage')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, 'preview'), { recursive: true })
  const staged = new Map()
  for (const f of baseFiles) {
    if (!f.path) continue
    const name = path.basename(f.path)
    const dst = path.join(stage, name)
    fs.copyFileSync(path.join(dir, 'out', name), dst)
    let preview = path.join(stage, 'preview', `${f.part ?? path.parse(name).name}.jpg`)
    try {
      await previewer(dst, preview)
    } catch (e) {
      deps.log?.(`${itemId}: không làm được ảnh xem trước ${name}: ${errText(e)}`)
      preview = null
    }
    staged.set(name, { path: dst, sha256: await sha256File(dst), preview })
  }
  let qa
  try {
    qa = normQa(await qaItem(stage))
  } catch (e) {
    qa = { verdict: 'unchecked', items: [`không chạy được kiểm tra máy: ${errText(e)}`] }
  }
  return withLocksRetry(queue, itemId, async () => {
    const item = await queue.get(itemId)
    if (item.status !== 'fixing' || item.version !== job.version) return { failed: `dòng đã đổi trong lúc sửa (đang ${item.status}, v${item.version})` }
    const cur = (await queue.versions(itemId)).find(v => v.n === item.version)
    const n = item.version + 1
    const oldDir = path.join(itemDir(queue, itemId), `v${item.version}`)
    const vdir = path.join(itemDir(queue, itemId), `v${n}`)
    fs.rmSync(vdir, { recursive: true, force: true })
    fs.mkdirSync(path.join(vdir, 'preview'), { recursive: true })
    let recorded = false
    try {
      const copyOf = new Map()
      const files = []
      for (const f of cur.files ?? []) {
        if (!f.path) { files.push(f); continue }
        const name = path.basename(f.path)
        const st = staged.get(name)
        if (!st) throw new Error(`thiếu ${name} trong bản chuẩn bị (stage\\)`)
        const dst = path.join(vdir, name)
        fs.copyFileSync(st.path, dst)
        const sha256 = await sha256File(dst)
        if (sha256 !== st.sha256) throw new Error(`${name} đổi trong lúc chép`)
        let preview = null
        if (st.preview && isFile(st.preview)) {
          preview = path.join(vdir, 'preview', path.basename(st.preview))
          fs.copyFileSync(st.preview, preview)
        }
        files.push({ ...f, path: dst, sha256, preview, source: path.join(dir, 'out', name) })
        copyOf.set(path.resolve(f.path), dst)
      }
      const meta = { ...item.meta }
      for (const [field] of REF_IMAGES) {
        const old = meta[field]
        if (old && isFile(old) && path.resolve(path.dirname(old)) === path.resolve(oldDir)) {
          const dst = path.join(vdir, path.basename(old))
          fs.copyFileSync(old, dst)
          meta[field] = dst
        }
      }
      const apiLines = (item.apiLines ?? []).map(l => ({
        ...l,
        files: (l.files ?? []).map(f => {
          if (!f.path || !copyOf.has(path.resolve(f.path))) return f
          const { knownDriveFileId: _known, ...rest } = f
          return { ...rest, path: copyOf.get(path.resolve(f.path)) }
        }),
      }))
      const r = await queue.addOrUpdate({
        id: itemId, taskKey: item.taskKey, taskKeys: await queue.memberKeys(itemId), groupKey: item.groupKey, kind: item.kind,
        apiLines, files, meta, qa,
      })
      if (!r.changed) return { failed: 'file trong out\\ giống hệt bản hiện tại' }
      recorded = true
      const status = qa.verdict === 'fail' ? 'qa_failed' : 'waiting'
      const notesFile = path.join(dir, 'out', 'NOTES.md')
      const notes = isFile(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : ''
      await queue.setStatus(itemId, status, { reason: `Bản sửa của agent ${job.agent} (job ${job.n}) — chờ duyệt lại` })
      await queue.addEvent(itemId, 'fix_done', `Agent ${job.agent} sửa xong (job ${job.n}) → v${r.version}: ${clip(notes || last || 'không có ghi chú')}`)
      return { ok: true, itemId, version: r.version, status }
    } finally {
      if (!recorded) fs.rmSync(vdir, { recursive: true, force: true })
    }
  }, deps)
}

async function runNow(queue, jobId, deps) {
  try {
    return await runJob(queue, jobId, deps)
  } finally {
    ownJobs.delete(jobId)
  }
}

async function runJob(queue, jobId, deps) {
  const now = deps.now ?? (() => new Date())
  const ref = parseJobId(jobId)
  const job = ref && readJob(queue, jobId)
  if (!job) return fail(ref?.itemId ?? null, 'not_found', `Không có job ${jobId}`)
  const dir = jobDirOf(queue, jobId)
  if (job.status !== 'queued') return fail(job.itemId, 'not_queued', `Job ${jobId} đang ${job.status}`, { jobId })
  const item = await queue.get(job.itemId)
  if (!item || item.status !== 'fixing') {
    writeJob(dir, { ...job, status: 'failed', finishedAt: now().toISOString(), message: 'dòng không còn ở trạng thái đang sửa' })
    return fail(job.itemId, 'not_fixing', `Dòng ${job.itemId} không còn ở trạng thái đang sửa`, { jobId })
  }
  let running = job
  try {
    const cmd = await agentCommand(job.agent, dir, deps)
    const before = snapshot(queue, item.id, dir)
    running = writeJob(dir, { ...job, status: 'running', startedAt: now().toISOString(), cmd: cmd.cmd, args: cmd.args })
    const run = await runAgent(cmd, dir, {
      ...deps,
      onSpawn: child => { if (child?.pid) running = writeJob(dir, { ...running, pid: child.pid }) },
    })
    const last = lastMessage(job.agent, dir, run)
    const ran = { exitCode: run.exitCode ?? null, signal: run.signal ?? null, lastMessage: clip(last) }
    const problems = []
    if (run.timedOut) problems.push(`hết ${Math.round((deps.limitMs ?? FIX_LIMIT_MS) / 60_000)} phút — đã dừng agent`)
    else if (run.error) problems.push(`không chạy được ${cmd.cmd}: ${run.error}`)
    const outside = changedSince(before, snapshot(queue, item.id, dir), queue.root)
    if (outside.length) problems.push(`agent ghi ra ngoài thư mục out\\: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` (+${outside.length - 5})` : ''}`)
    if (!problems.length) problems.push(...await checkOut(dir, job.parts ?? [], deps.imageSize ?? readImageSize))
    if (problems.length) return await failJob(queue, item, dir, running, problems, last, deps, ran)
    const r = await recordVersion(queue, item.id, dir, running, last, deps)
    if (r?.ok) {
      writeJob(dir, { ...running, ...ran, status: 'done', finishedAt: now().toISOString(), resultVersion: r.version })
      return { ...r, jobId }
    }
    const why = r?.failed ?? (r?.code === 'locked' ? 'không ghi được bản mới: dòng đang bị khoá' : r?.error ?? 'không ghi được bản mới')
    return await failJob(queue, item, dir, running, [why], last, deps, ran)
  } catch (e) {
    return failJob(queue, item, dir, running, [errText(e)], '', deps)
  }
}

let chain = Promise.resolve()

/**
 * Runs a job made by startFix; jobs of this process run one at a time (a later call waits, its job.json stays `queued`).
 * deps: { spawn?, codexExe?, codexModel?, claudeExe?, claudeHelp?, qaItem?(versionDir), previewer?, imageSize?, now?, env?, limitMs?, killTree?, sleep?, log? }
 * @returns {Promise<any>} { ok:true, itemId, jobId, version, status:'waiting'|'qa_failed' } or { ok:false, itemId, code, error, status?, jobId? }
 */
export function runFixJob(queue, jobId, deps = {}) {
  ownJobs.add(jobId)
  const run = chain.then(() => runNow(queue, jobId, deps))
  chain = run.catch(() => {})
  return run
}

/** Image name of a live pid (`tasklist /FI "PID eq <pid>" /FO CSV /NH`), or null when no such process runs. */
export function processImage(pid) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise(resolve => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15_000 }, (e, stdout) => {
      const m = !e && /^"([^"]+)","(\d+)"/m.exec(String(stdout))
      resolve(m && Number(m[2]) === Number(pid) ? m[1] : null)
    })
  })
}

function killPid(pid) {
  return new Promise(resolve => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve(undefined)))
}

/** Command line of a live pid (Win32_Process via PowerShell), or null. */
export function processCommandLine(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return Promise.resolve(null)
  const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 }, (e, stdout) => {
      resolve(e ? null : String(stdout).trim() || null)
    })
  })
}

const AGENT_IMAGES = new Set(['claude.exe', 'codex.exe'])
const pathKey = p => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * At server start: an item left `fixing` by an earlier process goes to rejected with an event; its open jobs are marked failed.
 * A job's recorded pid is killed first only when it still runs as claude.exe / codex.exe AND its command line names the job
 * folder (many unrelated Claude/Codex processes run on this PC; a reused pid is left alone, with an event).
 * Jobs started by this process are left alone.
 * @param {any} queue
 * @param {{ log?: (m: string) => void, now?: () => Date, ownJobs?: Set<string>, processImage?: (pid: number) => Promise<string|null>, processCommandLine?: (pid: number) => Promise<string|null>, killPid?: (pid: number) => Promise<any> }} [opts]
 * @returns {Promise<string[]>} recovered item ids
 */
export async function recoverFixJobs(queue, {
  log = console.log, now = () => new Date(), ownJobs: mine = ownJobs, processImage: imageOf = processImage,
  processCommandLine: cmdlineOf = processCommandLine, killPid: kill = killPid,
} = {}) {
  const recovered = []
  for (const item of await queue.list({ statuses: ['fixing'] })) {
    const jobs = listJobs(queue, item.id)
    if (jobs.some(j => mine.has(j.id))) continue
    const text = `${FIX_FAILED}: job bị gián đoạn (server hàng chờ hoặc PC khởi động lại)`
    for (const j of jobs) {
      if (j.status !== 'queued' && j.status !== 'running') continue
      let killed = null
      let spared = null
      if (Number.isInteger(j.pid) && j.pid > 0) {
        const image = await imageOf(j.pid).catch(() => null)
        if (image && AGENT_IMAGES.has(image.toLowerCase())) {
          const cmdline = await cmdlineOf(j.pid).catch(() => null)
          if (cmdline && pathKey(cmdline).includes(pathKey(jobDirOf(queue, j.id)))) {
            await kill(j.pid)
            killed = j.pid
            await queue.addEvent(item.id, 'fix_kill', `Job ${j.n}: đã dừng agent còn chạy (${image}, pid ${j.pid})`)
          } else {
            spared = j.pid
            await queue.addEvent(item.id, 'fix_kill', `Job ${j.n}: pid ${j.pid} (${image}) không chạy thư mục job này — không dừng`)
          }
        }
      }
      writeJob(jobDirOf(queue, j.id), {
        ...j, status: 'failed', finishedAt: now().toISOString(), message: text,
        ...(killed ? { killedPid: killed } : {}), ...(spared ? { sparedPid: spared } : {}),
      })
    }
    await queue.setStatus(item.id, FAILED_STATUS, { reason: text })
    await queue.addEvent(item.id, 'fix_failed', text)
    log(`${item.taskKey}: ${text} → ${FAILED_STATUS}`)
    recovered.push(item.id)
  }
  return recovered
}

/** Real deps for the server: the installed Claude / Codex, the process environment (filtered per job), QA unchecked until wired. */
export function makeFixDeps({ env = process.env, log = console.log, qaItem = defaultQa } = {}) {
  return { spawn: nodeSpawn, codexExe: findCodexExe(env), codexModel: codexConfigModel(env), claudeExe: findClaudeExe(env), qaItem, env, log, killTree }
}
