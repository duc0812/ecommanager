import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import sharp from 'sharp'
import { openQueue, newItemId } from '../scripts/review-queue/store.mjs'
import {
  startFix, runFixJob, recoverFixJobs, readJob, listJobs, childEnv, findCodexExe, findClaudeExe, agentCommand,
  FIX_PROMPT, FIX_LIMIT_MS, CHILD_ENV_KEYS, codexConfigModel,
} from '../scripts/review-queue/fix-job.mjs'

let tmp: string
let clock: number
let q: any
let qaCalls: string[]
let logs: string[]

const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

type Child = EventEmitter & { stdout: PassThrough, stderr: PassThrough, kill: () => void, killed: boolean, pid: number }

function fakeChild(): Child {
  const c = new EventEmitter() as Child
  c.stdout = new PassThrough()
  c.stderr = new PassThrough()
  c.killed = false
  c.pid = 999_999
  c.kill = () => {
    c.killed = true
    setImmediate(() => { c.emit('exit', null, 'SIGTERM'); c.emit('close', null, 'SIGTERM') })
  }
  return c
}
const exit = (c: Child, code = 0) => setImmediate(() => { c.stdout.end(); c.stderr.end(); c.emit('exit', code, null); c.emit('close', code, null) })

type Behave = (args: { cmd: string, args: string[], opts: any, child: Child, job: string }) => void
function fakeSpawn(behave: Behave) {
  const calls: { cmd: string, args: string[], opts: any, child: Child }[] = []
  const spawn = (cmd: string, args: string[], opts: any) => {
    const child = fakeChild()
    calls.push({ cmd, args, opts, child })
    behave({ cmd, args, opts, child, job: opts.cwd })
    return child
  }
  return { spawn, calls }
}
const writeOut = (job: string, name: string, body: string | Buffer) => {
  fs.mkdirSync(path.join(job, 'out'), { recursive: true })
  fs.writeFileSync(path.join(job, 'out', name), body)
}

function deps(spawn: any, over: any = {}) {
  return {
    spawn,
    codexExe: 'C:\\fake\\codex.exe',
    claudeExe: 'C:\\fake\\claude-a.exe',
    claudeHelp: async () => 'Options:\n  --strict-mcp-config   Only use MCP servers from --mcp-config',
    qaItem: async (dir: string) => { qaCalls.push(dir); return { verdict: 'pass', items: [] } },
    previewer: async (_input: any, dst: string) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, 'JPEG') },
    now: () => new Date(clock),
    env: {
      Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', USERPROFILE: 'C:\\Users\\x', LOCALAPPDATA: 'C:\\l',
      ECOM_URL: 'https://prod', DESIGN_WORKER_TOKEN: 'w', DELIVERY_APPROVE_TOKEN: 'a', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_ENTRYPOINT: 'x',
      MCP_SERVER: 'm', DESIGN_AGENT_TOKEN: 'd',
    },
    log: (m: string) => { logs.push(m) },
    ...over,
  }
}

async function makeItem(taskKey: string, over: { status?: string, qa?: any, body?: string | Buffer, second?: boolean } = {}) {
  const id = newItemId()
  const vdir = path.join(q.root, 'items', id, 'v1')
  fs.mkdirSync(path.join(vdir, 'preview'), { recursive: true })
  const front = path.join(vdir, 'PRINT_Front.png')
  fs.writeFileSync(front, over.body ?? `ART-v1-${taskKey}`)
  fs.writeFileSync(path.join(vdir, 'preview', 'PRINT_Front.jpg'), 'JPEG')
  fs.writeFileSync(path.join(vdir, 'customer.jpg'), 'CUSTOMER')
  const files = [{ part: 'PRINT_Front', kind: 'PRINT', printArea: 'Front', taskKey, fileName: `${taskKey}-front.png`, path: front, sha256: sha(front), preview: path.join(vdir, 'preview', 'PRINT_Front.jpg'), source: 'D:\\renders\\front.png' }]
  const apiLines: any[] = [{ taskKey, action: 'push', retire: [], expectedStatus: 'NEW', files: [{ kind: 'PRINT', printArea: 'Front', path: front, fileName: `${taskKey}-front.png`, mimeType: 'image/png' }] }]
  const keys = [taskKey]
  if (over.second) {
    apiLines.push({ taskKey: 'LIT2_1', action: 'push', retire: [], expectedStatus: 'NEW', files: [{ kind: 'PRINT', printArea: 'Front', fileName: 'LIT2_1-front.png', sharedFrom: taskKey, sharedKey: 'PRINT:Front' }] })
    keys.push('LIT2_1')
  }
  await q.addOrUpdate({
    id, taskKey, taskKeys: keys, groupKey: taskKey, kind: keys.length > 1 ? 'group' : 'line', apiLines, files,
    meta: {
      taskKey, productTitle: 'Áo hoodie gia đình', variantTitle: 'Black / L', sku: 'TN1', supplierSku: 'MWHD', orderNumber: 'LIT1',
      placedAt: '2026-11-14T10:00:00.000Z', custom: [{ name: 'Name', value: 'Anna' }], customerPreview: path.join(vdir, 'customer.jpg'),
      customerPreviewUrl: 'https://cdn/x.jpg', storeImage: null, ledgerPath: path.join(tmp, 'ledger.json'), spec: 'D:\\specs\\flat-text\\TN1\\spec.json',
    },
    qa: over.qa ?? { verdict: 'pass', items: [] },
  })
  if (over.status) await q.setStatus(id, over.status, { reason: 'trước' })
  return id
}

const start = async (id: string, extra: any = {}, d: any = {}) =>
  startFix(q, id, { agent: 'codex', reason: 'Tên bị lệch sang trái', version: (await q.get(id)).version, ...extra }, d)
const messages = async (id: string) => (await q.events(id)).map((e: any) => e.message).join('\n')

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-fix-'))
  clock = Date.parse('2026-11-16T01:00:00Z')
  q = await openQueue({ root: path.join(tmp, 'queue'), now: () => new Date(clock) })
  qaCalls = []
  logs = []
})
afterEach(async () => {
  vi.useRealTimers()
  await q.close()
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
})

describe('startFix', () => {
  it('makes the job folder (BRIEF.md, in\\ copies, ref\\, job.json) and sets fixing with an event', async () => {
    const id = await makeItem('LIT1_1', { qa: { verdict: 'fail', items: ['tên tràn khung'] } })
    const r = await start(id)
    expect(r).toMatchObject({ ok: true, itemId: id, status: 'fixing' })
    const job = path.join(q.root, 'items', id, 'jobs', '1')
    expect(r.jobId).toBe(`${id}-1`)
    expect(fs.readFileSync(path.join(job, 'in', 'PRINT_Front.png'), 'utf8')).toBe('ART-v1-LIT1_1')
    expect(fs.readFileSync(path.join(job, 'ref', 'customer.jpg'), 'utf8')).toBe('CUSTOMER')
    expect(fs.existsSync(path.join(job, 'out'))).toBe(true)
    const brief = fs.readFileSync(path.join(job, 'BRIEF.md'), 'utf8')
    for (const s of ['LIT1_1', 'Áo hoodie gia đình', 'Black / L', 'Anna', 'Tên bị lệch sang trái', 'tên tràn khung', 'in\\PRINT_Front.png', 'out\\', 'NOTES.md', 'D:\\specs\\flat-text\\TN1\\spec.json', '11/14/2026']) {
      expect(brief).toContain(s)
    }
    expect(readJob(q, r.jobId)).toMatchObject({ status: 'queued', agent: 'codex', itemId: id, version: 1, reason: 'Tên bị lệch sang trái' })
    const item = await q.get(id)
    expect(item.status).toBe('fixing')
    expect(item.prevStatus).toBe('qa_failed')
    expect(await messages(id)).toMatch(/codex.*Tên bị lệch sang trái/)
  })

  it('refuses a wrong agent, a missing or old version, and an item that is not fixable — nothing created', async () => {
    const id = await makeItem('LIT1_1')
    expect(await startFix(q, id, { agent: 'gpt', reason: 'x', version: 1 })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await startFix(q, id, { agent: 'claude', reason: 'x' } as any)).toMatchObject({ ok: false, code: 'version_required' })
    expect(await startFix(q, id, { agent: 'claude', reason: 'x', version: 2 })).toMatchObject({ ok: false, code: 'version_changed', version: 1 })
    expect(await startFix(q, id, { agent: 'claude', reason: '  ', version: 1 })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(fs.existsSync(path.join(q.root, 'items', id, 'jobs'))).toBe(false)
    const done = await makeItem('LIT5_1', { status: 'approved' })
    expect(await startFix(q, done, { agent: 'claude', reason: 'x', version: 1 })).toMatchObject({ ok: false, code: 'not_fixable' })
    expect((await start(id)).ok).toBe(true)
    expect(await start(id)).toMatchObject({ ok: false, code: 'not_fixable', status: 'fixing' })
    expect(listJobs(q, id)).toHaveLength(1)
  })
})

describe('runFixJob', () => {
  it('codex success: exact argv and clean env, out\\ becomes v2 (waiting, clock restarts), apiLines point at v2', async () => {
    const id = await makeItem('LIT1_1', { status: 'rejected' })
    const { jobId } = await start(id)
    const { spawn, calls } = fakeSpawn(({ child, job }) => {
      writeOut(job, 'PRINT_Front.png', 'ART-fixed')
      writeOut(job, 'NOTES.md', 'Dời tên vào giữa')
      fs.writeFileSync(path.join(job, 'last-message.txt'), 'Đã sửa')
      exit(child)
    })
    clock += 30 * 60_000
    const locksFreeDuringQa: boolean[] = []
    const qaItem = async (dir: string) => {
      qaCalls.push(dir)
      try {
        await q.withLock(id, async () => q.withLock('intake:LIT1_1', async () => {}))
        locksFreeDuringQa.push(true)
      } catch {
        locksFreeDuringQa.push(false)
      }
      return { verdict: 'pass', items: [] }
    }
    const r = await runFixJob(q, jobId, deps(spawn, { codexModel: 'gpt-test', qaItem }))
    expect(r).toMatchObject({ ok: true, itemId: id, status: 'waiting', version: 2 })
    const job = path.join(q.root, 'items', id, 'jobs', '1')
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('C:\\fake\\codex.exe')
    expect(calls[0].args).toEqual(['exec', '--ignore-user-config', '-m', 'gpt-test', '-C', job, '--skip-git-repo-check', '--sandbox', 'workspace-write', '-o', path.join(job, 'last-message.txt'), FIX_PROMPT])
    expect(calls[0].opts.cwd).toBe(job)
    const env = calls[0].opts.env
    expect(Object.keys(env).sort()).toEqual(['DISABLE_AUTOUPDATER', 'LOCALAPPDATA', 'PATH', 'PYTHONIOENCODING', 'PYTHONUTF8', 'SYSTEMROOT', 'TEMP', 'USERPROFILE'])
    expect(env).toMatchObject({ PATH: 'C:\\Windows', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DISABLE_AUTOUPDATER: '1' })
    const item = await q.get(id)
    expect(item).toMatchObject({ status: 'waiting', version: 2, enteredAt: new Date(clock).toISOString() })
    const v2 = path.join(q.root, 'items', id, 'v2')
    expect(fs.readFileSync(path.join(v2, 'PRINT_Front.png'), 'utf8')).toBe('ART-fixed')
    expect(fs.existsSync(path.join(v2, 'preview', 'PRINT_Front.jpg'))).toBe(true)
    expect(fs.readFileSync(path.join(v2, 'customer.jpg'), 'utf8')).toBe('CUSTOMER')
    expect(item.meta.customerPreview).toBe(path.join(v2, 'customer.jpg'))
    expect(item.apiLines[0].files[0].path).toBe(path.join(v2, 'PRINT_Front.png'))
    expect(fs.readFileSync(path.join(q.root, 'items', id, 'v1', 'PRINT_Front.png'), 'utf8')).toBe('ART-v1-LIT1_1')
    const v = (await q.versions(id)).find((x: any) => x.n === 2)
    expect(v.files[0]).toMatchObject({ part: 'PRINT_Front', path: path.join(v2, 'PRINT_Front.png'), sha256: sha(path.join(v2, 'PRINT_Front.png')) })
    expect(qaCalls).toEqual([path.join(job, 'stage')])
    expect(locksFreeDuringQa).toEqual([true])
    expect(fs.readFileSync(path.join(job, 'stage', 'PRINT_Front.png'), 'utf8')).toBe('ART-fixed')
    expect(readJob(q, jobId)).toMatchObject({ status: 'done', resultVersion: 2 })
    expect(await messages(id)).toMatch(/sửa xong.*v2.*Dời tên vào giữa/)
  })

  it('claude: exact argv with --strict-mcp-config when the CLI has it (no --mcp-config), JSON result kept, QA fail → qa_failed', async () => {
    const id = await makeItem('LIT1_1')
    const { jobId } = await startFix(q, id, { agent: 'claude', reason: 'Màu nhạt', version: 1 })
    const { spawn, calls } = fakeSpawn(({ child, job }) => {
      writeOut(job, 'PRINT_Front.png', 'ART-claude')
      child.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Đã tăng màu' }))
      exit(child)
    })
    const r = await runFixJob(q, jobId, deps(spawn, { qaItem: async () => ({ verdict: 'fail', items: ['tên tràn khung'] }) }))
    const job = path.join(q.root, 'items', id, 'jobs', '1')
    expect(calls[0].cmd).toBe('C:\\fake\\claude-a.exe')
    expect(calls[0].args).toEqual(['-p', FIX_PROMPT, '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', '--add-dir', job, '--strict-mcp-config'])
    expect(calls[0].args).not.toContain('--mcp-config')
    expect(calls[0].opts.cwd).toBe(job)
    expect(r).toMatchObject({ ok: true, status: 'qa_failed', version: 2 })
    expect((await q.get(id)).qa).toEqual({ verdict: 'fail', items: ['tên tràn khung'] })
    expect(fs.readFileSync(path.join(job, 'last-message.txt'), 'utf8')).toBe('Đã tăng màu')
  })

  it('claude without --strict-mcp-config in its help: the flag is left out (help read once per exe)', async () => {
    let helps = 0
    const d = { claudeExe: 'C:\\fake\\claude-b.exe', claudeHelp: async () => { helps++; return 'Options:\n  --mcp-config <configs...>' } }
    const job = path.join(tmp, 'job')
    const a = await agentCommand('claude', job, d)
    const b = await agentCommand('claude', job, d)
    expect(a.args).toEqual(['-p', FIX_PROMPT, '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', '--add-dir', job])
    expect(b.args).toEqual(a.args)
    expect(helps).toBe(1)
  })

  it('agent writes nothing: a waiting item goes to rejected (no countdown), reason = the last message cut to 500 chars, no new version', async () => {
    const id = await makeItem('LIT1_1')
    const { jobId } = await start(id)
    const long = 'x'.repeat(480) + 'KẾT-THÚC' + 'y'.repeat(300)
    const { spawn } = fakeSpawn(({ child, job }) => {
      fs.writeFileSync(path.join(job, 'last-message.txt'), long)
      exit(child, 1)
    })
    const r = await runFixJob(q, jobId, deps(spawn))
    expect(r).toMatchObject({ ok: false, code: 'fix_failed', status: 'rejected' })
    const item = await q.get(id)
    expect(item).toMatchObject({ status: 'rejected', version: 1 })
    const ev = (await q.events(id)).find((e: any) => e.type === 'fix_failed')
    expect(ev.message).toBe(`agent không sửa được: ${long.slice(0, 500)}`)
    expect(item.statusReason).toBe(ev.message)
    expect(await messages(id)).toContain('Job 1: thiếu out\\PRINT_Front.png')
    expect(await q.expired(clock + 10 * 3_600_000)).toEqual([])
    expect(fs.existsSync(path.join(q.root, 'items', id, 'v2'))).toBe(false)
    expect(readJob(q, jobId)).toMatchObject({ status: 'failed' })
  })

  it('failure message: out\\NOTES.md first 500 chars wins; without a last message Codex stdout tail beats stderr', async () => {
    const notesItem = await makeItem('LIT1_1')
    const notes = 'N'.repeat(450) + 'GIỮA' + 'M'.repeat(200)
    const a = await start(notesItem)
    const sa = fakeSpawn(({ child, job }) => {
      writeOut(job, 'NOTES.md', notes)
      fs.writeFileSync(path.join(job, 'last-message.txt'), 'tin nhắn cuối')
      exit(child, 1)
    })
    await runFixJob(q, a.jobId, deps(sa.spawn))
    expect((await q.get(notesItem)).statusReason).toBe(`agent không sửa được: ${notes.slice(0, 500)}`)

    const streamItem = await makeItem('LIT2_1')
    const b = await start(streamItem)
    const out = 'HEAD-' + 's'.repeat(600) + '-STDOUT-END'
    const sb = fakeSpawn(({ child }) => {
      child.stdout.write(out)
      child.stderr.write('stderr text')
      exit(child, 1)
    })
    await runFixJob(q, b.jobId, deps(sb.spawn))
    expect((await q.get(streamItem)).statusReason).toBe(`agent không sửa được: ${out.slice(-500)}`)
  })

  it('an early refusal in runFixJob does not keep the job marked as this process’s (recovery can take it)', async () => {
    const id = await makeItem('LIT1_1')
    const { jobId } = await start(id)
    const file = path.join(q.root, 'items', id, 'jobs', '1', 'job.json')
    fs.writeFileSync(file, JSON.stringify({ ...readJob(q, jobId), status: 'running' }))
    expect(await runFixJob(q, jobId, deps(fakeSpawn(() => {}).spawn))).toMatchObject({ ok: false, code: 'not_queued' })
    expect(await recoverFixJobs(q, { log: () => {}, processImage: async () => null })).toEqual([id])
  })

  it('startFix: a failing setStatus removes the job folder and leaves no job behind', async () => {
    const id = await makeItem('LIT1_1')
    const broken = Object.create(q)
    broken.setStatus = async () => { throw new Error('db busy') }
    const r = await startFix(broken, id, { agent: 'codex', reason: 'x', version: 1 })
    expect(r).toMatchObject({ ok: false, code: 'error' })
    expect(fs.existsSync(path.join(q.root, 'items', id, 'jobs', '1'))).toBe(false)
    expect((await q.get(id)).status).toBe('waiting')
  })

  it('agent writes outside its job folder (the item version, in\\, another item): fail, no new version', async () => {
    const other = await makeItem('LIT7_1')
    const cases: [string, (job: string, id: string) => void][] = [
      ['version', (_job, id) => fs.writeFileSync(path.join(q.root, 'items', id, 'v1', 'PRINT_Front.png'), 'OVERWRITTEN')],
      ['in', job => fs.writeFileSync(path.join(job, 'in', 'PRINT_Front.png'), 'CHANGED-IN')],
      ['other', () => fs.writeFileSync(path.join(q.root, 'items', other, 'v1', 'PRINT_Front.png'), 'OTHER')],
    ]
    for (const [name, write] of cases) {
      const id = await makeItem(`LIT_${name}`)
      const { jobId } = await start(id)
      const { spawn } = fakeSpawn(({ child, job }) => {
        writeOut(job, 'PRINT_Front.png', `ART-${name}`)
        write(job, id)
        exit(child)
      })
      const r = await runFixJob(q, jobId, deps(spawn))
      expect(r, name).toMatchObject({ ok: false, code: 'fix_failed', status: 'rejected' })
      expect((await q.get(id)).version, name).toBe(1)
      expect(await messages(id), name).toMatch(/ngoài thư mục/)
    }
  })

  it('a missing part, an unchanged copy or a wrong pixel size in out\\ is a failure', async () => {
    const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#ff0000' } }).png().toBuffer()
    const sized = await makeItem('LIT8_1', { body: await png(20, 10) })
    const same = await makeItem('LIT9_1')
    const missing = await makeItem('LIT10_1')
    const outs: Record<string, (job: string) => Promise<void>> = {
      [sized]: async job => writeOut(job, 'PRINT_Front.png', await png(10, 10)),
      [same]: async job => writeOut(job, 'PRINT_Front.png', 'ART-v1-LIT9_1'),
      [missing]: async job => writeOut(job, 'NOTES.md', 'không sửa được'),
    }
    const why: Record<string, RegExp> = { [sized]: /10x10.*20x10/, [same]: /giống hệt/, [missing]: /thiếu out\\PRINT_Front\.png/ }
    for (const id of [sized, same, missing]) {
      const { jobId } = await start(id)
      const { spawn } = fakeSpawn(({ child, job }) => { outs[id](job).then(() => exit(child)) })
      const r = await runFixJob(q, jobId, deps(spawn))
      expect(r).toMatchObject({ ok: false, code: 'fix_failed', status: 'rejected' })
      expect((await q.get(id)).version).toBe(1)
      expect(await messages(id)).toMatch(why[id])
      expect(fs.existsSync(path.join(q.root, 'items', id, 'v2'))).toBe(false)
    }
  })

  it('a hanging agent is killed at the 60-minute limit (RF 3): qa_failed item goes to rejected, nothing recorded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const id = await makeItem('LIT1_1', { qa: { verdict: 'fail', items: ['lệch khổ'] } })
    const { jobId } = await start(id)
    const { spawn, calls } = fakeSpawn(({ job }) => { writeOut(job, 'PRINT_Front.png', 'HALF') })
    const p = runFixJob(q, jobId, deps(spawn))
    await vi.advanceTimersByTimeAsync(FIX_LIMIT_MS - 1000)
    expect(calls[0].child.killed).toBe(false)
    expect((await q.get(id)).status).toBe('fixing')
    await vi.advanceTimersByTimeAsync(2000)
    const r = await p
    expect(calls[0].child.killed).toBe(true)
    expect(r).toMatchObject({ ok: false, code: 'fix_failed', status: 'rejected' })
    expect(await messages(id)).toMatch(/hết 60 phút/)
    expect((await q.get(id)).version).toBe(1)
  })

  it('one job at a time: a second job waits (queued) until the first one exits', async () => {
    const a = await makeItem('LIT1_1')
    const b = await makeItem('LIT2_1')
    const ja = (await start(a)).jobId
    const jb = (await start(b)).jobId
    let releaseA: () => void = () => {}
    const { spawn, calls } = fakeSpawn(({ child, job }) => {
      writeOut(job, 'PRINT_Front.png', `FIX-${job}`)
      if (calls.length === 1) releaseA = () => exit(child)
      else exit(child)
    })
    const d = deps(spawn)
    const pa = runFixJob(q, ja, d)
    const pb = runFixJob(q, jb, d)
    await new Promise(r => setTimeout(r, 150))
    expect(calls).toHaveLength(1)
    expect(readJob(q, ja)).toMatchObject({ status: 'running', pid: 999_999 })
    expect(readJob(q, jb).status).toBe('queued')
    releaseA()
    expect(await pa).toMatchObject({ ok: true })
    expect(await pb).toMatchObject({ ok: true })
    expect(calls).toHaveLength(2)
    expect(calls[1].opts.cwd).toBe(path.join(q.root, 'items', b, 'jobs', '1'))
  })

  it('a group item keeps its member keys and its later shared line', async () => {
    const id = await makeItem('LIT1_1', { second: true })
    const { jobId } = await start(id)
    const { spawn } = fakeSpawn(({ child, job }) => { writeOut(job, 'PRINT_Front.png', 'ART-group'); exit(child) })
    expect(await runFixJob(q, jobId, deps(spawn))).toMatchObject({ ok: true, version: 2 })
    const item = await q.get(id)
    expect(await q.memberKeys(id)).toEqual(['LIT1_1', 'LIT2_1'])
    expect(item.kind).toBe('group')
    expect(item.apiLines[1].files[0]).toMatchObject({ sharedFrom: 'LIT1_1', sharedKey: 'PRINT:Front' })
    expect(item.apiLines[1].files[0].path).toBeUndefined()
  })

  it('an unknown job id or a job already run is refused', async () => {
    expect(await runFixJob(q, 'rq_nope-1', deps(fakeSpawn(() => {}).spawn))).toMatchObject({ ok: false, code: 'not_found' })
    const id = await makeItem('LIT1_1')
    const { jobId } = await start(id)
    const { spawn } = fakeSpawn(({ child, job }) => { writeOut(job, 'PRINT_Front.png', 'X'); exit(child) })
    await runFixJob(q, jobId, deps(spawn))
    expect(await runFixJob(q, jobId, deps(spawn))).toMatchObject({ ok: false, code: 'not_queued' })
  })
})

describe('recoverFixJobs', () => {
  it('after a restart: only a claude.exe/codex.exe pid whose command line names the job folder is killed; the item goes to rejected', async () => {
    const cases: [string, string | null, boolean][] = [
      ['claude', 'claude.exe', true], ['codex', 'CODEX.EXE', true], ['otherclaude', 'claude.exe', false], ['reused', 'notepad.exe', false], ['gone', null, false],
    ]
    const cmdlines: Record<string, (job: string) => string> = {
      claude: job => `"C:\\Users\\x\\.local\\bin\\claude.exe" -p "Đọc BRIEF.md" --add-dir ${job.replace(/\\/g, '/').toUpperCase()} --strict-mcp-config`,
      codex: job => `C:\\l\\codex.exe exec --ignore-user-config -C "${job}\\" --skip-git-repo-check`,
      otherclaude: () => 'C:\\Users\\x\\.local\\bin\\claude.exe --resume abc',
    }
    const ids: Record<string, string> = {}
    const pids: Record<string, number> = {}
    for (let i = 0; i < cases.length; i++) {
      const name = cases[i][0]
      const id = await makeItem(`LIT_${name}`)
      const { jobId } = await start(id)
      pids[name] = 4000 + i
      fs.writeFileSync(path.join(q.root, 'items', id, 'jobs', '1', 'job.json'), JSON.stringify({ ...readJob(q, jobId), status: 'running', pid: pids[name] }))
      ids[name] = id
    }
    const images = new Map(cases.map(([name, image]) => [pids[name], image]))
    const byPid = new Map(cases.map(([name]) => [pids[name], name]))
    const asked: number[] = []
    const askedCmd: number[] = []
    const killed: number[] = []
    const q2 = await openQueue({ root: q.root, now: () => new Date(clock) })
    try {
      const r = await recoverFixJobs(q2, {
        log: (m: string) => logs.push(m), ownJobs: new Set(),
        processImage: async (pid: number) => { asked.push(pid); return images.get(pid) ?? null },
        processCommandLine: async (pid: number) => {
          askedCmd.push(pid)
          const name = byPid.get(pid) as string
          return cmdlines[name]?.(path.join(q.root, 'items', ids[name], 'jobs', '1')) ?? null
        },
        killPid: async (pid: number) => { killed.push(pid) },
      })
      expect(r.sort()).toEqual(Object.values(ids).sort())
    } finally {
      await q2.close()
    }
    expect(asked.sort()).toEqual(Object.values(pids).sort())
    expect(askedCmd.sort()).toEqual([pids.claude, pids.codex, pids.otherclaude].sort())
    expect(killed.sort()).toEqual([pids.claude, pids.codex].sort())
    for (const [name, , kill] of cases) {
      const id = ids[name]
      expect((await q.get(id)).status, name).toBe('rejected')
      const job = readJob(q, `${id}-1`)
      expect(job.status, name).toBe('failed')
      expect(job.killedPid, name).toBe(kill ? pids[name] : undefined)
      expect(await messages(id), name).toMatch(/agent không sửa được: .*gián đoạn/)
    }
    expect(readJob(q, `${ids.otherclaude}-1`).sparedPid).toBe(pids.otherclaude)
    expect(await messages(ids.otherclaude)).toMatch(/pid \d+ \(claude\.exe\) không chạy thư mục job này — không dừng/)
    expect(await messages(ids.claude)).toMatch(/đã dừng agent còn chạy/)
  })

  it('leaves a job started by this process alone', async () => {
    const id = await makeItem('LIT1_1')
    await start(id)
    expect(await recoverFixJobs(q, { log: () => {} })).toEqual([])
    expect((await q.get(id)).status).toBe('fixing')
  })
})

describe('environment and executables', () => {
  it('childEnv copies only the allowed keys (any case) and adds the python/updater flags', () => {
    const env = childEnv({ Path: 'P', ComSpec: 'cmd', windir: 'W', ECOM_URL: 'u', SHOPIFY_TOKEN: 't', ANTHROPIC_API_KEY: 'a', CLAUDECODE: '1', MCP_X: 'm', HOME: 'h' })
    expect(env).toEqual({ PATH: 'P', COMSPEC: 'cmd', WINDIR: 'W', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DISABLE_AUTOUPDATER: '1' })
    expect(CHILD_ENV_KEYS).not.toContain('ECOM_URL')
  })

  it('findCodexExe picks the newest bin/<hash>/codex.exe; findClaudeExe falls back to claude on PATH', () => {
    const local = path.join(tmp, 'local')
    const exe = (h: string, t: number) => {
      const p = path.join(local, 'OpenAI', 'Codex', 'bin', h, 'codex.exe')
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, 'x')
      fs.utimesSync(p, t, t)
      return p
    }
    exe('aaa', 1_700_000_000)
    const newest = exe('bbb', 1_800_000_000)
    fs.mkdirSync(path.join(local, 'OpenAI', 'Codex', 'bin', 'ccc'), { recursive: true })
    expect(findCodexExe({ LOCALAPPDATA: local })).toBe(newest)
    expect(findCodexExe({ LOCALAPPDATA: path.join(tmp, 'none') })).toBeNull()
    const home = path.join(tmp, 'home')
    expect(findClaudeExe({ USERPROFILE: home })).toBe('claude')
    const claude = path.join(home, '.local', 'bin', 'claude.exe')
    fs.mkdirSync(path.dirname(claude), { recursive: true })
    fs.writeFileSync(claude, 'x')
    expect(findClaudeExe({ USERPROFILE: home })).toBe(claude)
  })

  it('codexConfigModel reads only the top-level model; codex argv drops -m when there is none', async () => {
    const home = path.join(tmp, 'home')
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    const cfg = path.join(home, '.codex', 'config.toml')
    expect(codexConfigModel({ USERPROFILE: home })).toBeNull()
    fs.writeFileSync(cfg, '\uFEFFapproval_policy = "never"\r\nmodel = "gpt-6.1-sol"  # main\r\n[profiles.fast]\r\nmodel = "gpt-mini"\r\n')
    expect(codexConfigModel({ USERPROFILE: home })).toBe('gpt-6.1-sol')
    fs.writeFileSync(cfg, 'sandbox_mode = "danger-full-access"\n[profiles.fast]\nmodel = "gpt-mini"\n')
    expect(codexConfigModel({ USERPROFILE: home })).toBeNull()
    const job = path.join(tmp, 'job')
    const fromCfg = await agentCommand('codex', job, { codexExe: 'C:\\c.exe', env: { USERPROFILE: home } })
    expect(fromCfg.args).toEqual(['exec', '--ignore-user-config', '-C', job, '--skip-git-repo-check', '--sandbox', 'workspace-write', '-o', path.join(job, 'last-message.txt'), FIX_PROMPT])
    fs.writeFileSync(cfg, "model = 'gpt-x'\n")
    expect((await agentCommand('codex', job, { codexExe: 'C:\\c.exe', env: { USERPROFILE: home } })).args.slice(0, 4)).toEqual(['exec', '--ignore-user-config', '-m', 'gpt-x'])
  })
})
