import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openQueue } from '../scripts/review-queue/store.mjs'
import { approveItem, rejectItem, sendToCloud, removeItem, tickQueue, makeHold, loadEnvFiles, makeLiveDeps, TICK_BUDGET_MS } from '../scripts/review-queue/actions.mjs'
import { createDeliveryClient, DeliveryGaveUp } from '../scripts/lib/delivery-client.mjs'
import { main as tickMain } from '../scripts/review-queue/tick.mjs'

const H = 3_600_000
const APPROVE = 'APPROVE-SECRET'
const BASE = 'https://prod.test/api/design-studio/worker/delivery'
let tmp: string
let ledgerPath: string
let clock: number
let q: any
let prod: ReturnType<typeof fakeProd>
let holds: [string, string][]
let logs: string[]
let deps: any

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Task = { status: string; artworks: any[]; required?: string[]; closed?: boolean; refuseApprove?: string }

function fakeProd(tasks: Record<string, Task>) {
  const commits: { key: string; body: any; header: string | undefined }[] = []
  const uploads: any[] = []
  let n = 0
  const commit = (key: string, body: any, header: string | undefined) => {
    const t = tasks[key]
    if (!t) return json({ error: 'Không tìm thấy task', code: 'not_found' }, 404)
    if (body.approve && header !== APPROVE) return json({ error: 'Duyệt cần token duyệt riêng', code: 'approve_token' }, 403)
    const approveNow = () => {
      if (t.refuseApprove) return [`Không duyệt được: ${t.refuseApprove}`]
      t.status = 'DONE'
      return []
    }
    const applied = body.files.length && body.files.every((f: any) => t.artworks.some(a => a.driveFileId === f.driveFileId))
    if (applied) {
      if (body.dryRun) return json({ ok: true, status: t.status, artworks: t.artworks, missing: [], warnings: [], alreadyApplied: true, ...(body.approve ? { wouldApprove: t.status === 'REVIEW' } : {}) })
      const warnings = body.approve && t.status === 'REVIEW' ? approveNow() : []
      return json({ ok: true, status: t.status, artworks: t.artworks, missing: [], warnings, alreadyApplied: true })
    }
    if (t.closed) return json({ error: 'Đơn đã đóng', code: 'closed' }, 409)
    if (body.expected.status !== t.status) return json({ error: 'stale', code: 'stale' }, 409)
    const from = body.action === 'push' ? ['NEW', 'ASSIGNED', 'DOING', 'REJECTED'] : ['REVIEW', 'DOING', 'REJECTED', ...(body.allowFinished ? ['DONE'] : [])]
    if (!from.includes(t.status)) return json({ error: `Task đang ${t.status}`, code: 'wrong_state' }, 409)
    const kept = t.artworks.filter(a => !body.retire.includes(a.id))
    const areas = new Set([...kept, ...body.files].filter(x => x.kind === 'PRINT').map(x => String(x.printArea).toLowerCase()))
    const missing = (t.required ?? []).filter(r => !areas.has(r.toLowerCase()))
    const next = t.status === 'DONE' ? 'DONE' : missing.length ? t.status : 'REVIEW'
    if (body.dryRun) {
      return json({ ok: true, status: next, artworks: [], missing, warnings: [], alreadyApplied: false, ...(body.approve ? { wouldApprove: !missing.length && next === 'REVIEW' } : {}) })
    }
    t.artworks = [...kept, ...body.files.map((f: any) => ({ id: `art${++n}`, kind: f.kind, printArea: f.printArea, driveFileId: f.driveFileId, source: 'AUTO' }))]
    t.status = next
    const warnings: string[] = []
    if (body.approve) {
      if (next === 'REVIEW') warnings.push(...approveNow())
      else if (next !== 'DONE') warnings.push('Không duyệt được: thiếu phần')
    }
    return json({ ok: true, status: t.status, artworks: t.artworks, missing, warnings, alreadyApplied: false })
  }
  const fetchImpl: any = async (url: string, init: any = {}) => {
    const route = String(url).slice(BASE.length)
    const m = route.match(/^\/tasks\/([^/]+)(\/commit)?$/)
    if (!m) return json({ error: 'no route' }, 404)
    const key = decodeURIComponent(m[1])
    if (!m[2]) {
      const t = tasks[key]
      return t ? json({ taskKey: key, status: t.status, incomingFolder: { id: `INC-${key}` }, artworks: t.artworks }) : json({ error: 'Không tìm thấy task', code: 'not_found' }, 404)
    }
    const body = JSON.parse(init.body)
    commits.push({ key, body, header: init.headers['X-Delivery-Approve'] })
    return commit(key, body, init.headers['X-Delivery-Approve'])
  }
  const client = createDeliveryClient({ baseUrl: 'https://prod.test', token: 'worker', approveToken: APPROVE, fetchImpl, sleep: async () => {}, budgetMs: 0 })
  const uploader = {
    upload: async (a: any) => { uploads.push(a); return { id: `D-${a.name}-${uploads.length}`, size: fs.statSync(a.path).size } },
  }
  const real = () => commits.filter(c => !c.body.dryRun)
  return { tasks, commits, uploads, client, uploader, real }
}

const file = (name: string, body = 'ART') => {
  const p = path.join(tmp, 'files', name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, `${body}:${name}`)
  return p
}
const apiLine = (taskKey: string, over: any = {}) => ({
  taskKey, action: 'push', retire: [], expectedStatus: 'NEW',
  files: [{ kind: 'PRINT', printArea: 'Front', path: file(`${taskKey}-front.png`), fileName: `${taskKey}-front.png`, mimeType: 'image/png', widthPx: 10, heightPx: 10 }],
  ...over,
})
async function addItem(taskKey: string, over: any = {}) {
  const lines = over.apiLines ?? [apiLine(taskKey, over.line)]
  const r = await q.addOrUpdate({
    taskKey, groupKey: taskKey, taskKeys: lines.map((l: any) => l.taskKey), kind: lines.length > 1 ? 'group' : 'line',
    apiLines: lines,
    files: lines.flatMap((l: any) => l.files.filter((f: any) => f.path).map((f: any) => ({ part: `${f.kind}_${f.printArea}`, kind: f.kind, path: f.path, sha256: `sha-${f.path}` }))),
    meta: { ledgerPath, taskKey }, qa: over.qa ?? { verdict: 'pass', items: [] },
  })
  return r.itemId
}
const statusOf = async (id: string) => (await q.get(id)).status
const messages = async (id: string) => (await q.events(id)).map((e: any) => e.message).join('\n')
const approve = async (id: string, extra: any = {}, d: any = deps) => approveItem(q, id, d, { version: (await q.get(id))?.version ?? 1, ...extra })

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-actions-'))
  ledgerPath = path.join(tmp, 'out', 'api-ledger.json')
  clock = Date.parse('2026-11-16T01:00:00Z')
  q = await openQueue({ root: path.join(tmp, 'queue'), now: () => new Date(clock) })
  holds = []
  logs = []
  prod = fakeProd({ LIT1_1: { status: 'NEW', artworks: [] } })
  deps = {
    client: prod.client, uploader: prod.uploader, log: (m: string) => { logs.push(m) },
    hold: async (k: string, reason: string) => { holds.push([k, reason]); return { reported: true, jobId: null } },
  }
})
afterEach(async () => {
  await q.close()
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
})

describe('approveItem', () => {
  it('happy path: dry run with approve, then the real commit with approve → prod DONE, item approved', async () => {
    const id = await addItem('LIT1_1')
    const r = await approve(id)
    expect(r).toMatchObject({ ok: true, status: 'approved' })
    expect(prod.tasks.LIT1_1.status).toBe('DONE')
    expect(prod.commits.map(c => [c.body.dryRun === true, c.body.approve, c.header])).toEqual([[true, true, APPROVE], [false, true, APPROVE]])
    expect(prod.uploads).toHaveLength(1)
    expect(prod.uploads[0].path).toBe((await q.get(id)).apiLines[0].files[0].path)
    expect(await statusOf(id)).toBe('approved')
  })

  it('stale on prod (RF 5): needs_look, zero uploads, zero commits', async () => {
    prod.tasks.LIT1_1.status = 'DOING'
    const id = await addItem('LIT1_1')
    const r = await approve(id)
    expect(r).toMatchObject({ ok: false, status: 'needs_look' })
    expect(prod.uploads).toHaveLength(0)
    expect(prod.commits).toHaveLength(0)
    expect(await statusOf(id)).toBe('needs_look')
    expect(await messages(id)).toMatch(/LIT1_1: .*DOING/)
  })

  it('a task that no longer exists or a closed order is needs_look, nothing written on prod', async () => {
    const gone = await addItem('LIT9_1')
    expect((await approve(gone)).status).toBe('needs_look')
    prod.tasks.LIT1_1.closed = true
    const closed = await addItem('LIT1_1')
    expect((await approve(closed)).status).toBe('needs_look')
    expect(prod.real()).toHaveLength(0)
  })

  it('missing parts: nothing committed for real, item stays waiting with the reason', async () => {
    prod.tasks.LIT1_1.required = ['Front', 'Back']
    const id = await addItem('LIT1_1')
    const r = await approve(id)
    expect(r).toMatchObject({ ok: false, code: 'cannot_approve', status: 'waiting' })
    expect(r.error).toMatch(/thiếu Back/)
    expect(prod.real()).toHaveLength(0)
    expect(prod.tasks.LIT1_1).toMatchObject({ status: 'NEW', artworks: [] })
    expect(await statusOf(id)).toBe('waiting')
    expect(await messages(id)).toMatch(/thiếu Back/)
  })

  it('the app refuses the approval after the write: item cloud with the warning (it is on prod in REVIEW)', async () => {
    prod.tasks.LIT1_1.refuseApprove = 'kiểm tra cắt in'
    const id = await addItem('LIT1_1')
    const r = await approve(id)
    expect(r).toMatchObject({ ok: true, status: 'cloud' })
    expect(prod.tasks.LIT1_1.status).toBe('REVIEW')
    expect(await messages(id)).toMatch(/Không duyệt được: kiểm tra cắt in/)
  })

  it('a replace on a DONE line (wouldApprove false by design) goes without approve and ends approved', async () => {
    prod.tasks.LIT1_1 = { status: 'DONE', artworks: [{ id: 'old1', kind: 'PRINT', printArea: 'Front', driveFileId: 'D-old', source: 'AUTO' }] }
    const id = await addItem('LIT1_1', { line: { action: 'replace', retire: ['old1'], planIds: ['old1'], expectedStatus: 'DONE', allowFinished: true } })
    const r = await approve(id)
    expect(r).toMatchObject({ ok: true, status: 'approved' })
    const real = prod.real()
    expect(real).toHaveLength(1)
    expect('approve' in real[0].body).toBe(false)
    expect(real[0].header).toBeUndefined()
    expect(prod.tasks.LIT1_1.artworks.map(a => a.id)).not.toContain('old1')
  })

  it('double approve and approve during the tick (RF 1): one delivery', async () => {
    const id = await addItem('LIT1_1')
    const [a, b] = await Promise.all([approve(id), approve(id)])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect([a, b].find(x => !x.ok)?.code).toBe('locked')
    expect(await approve(id)).toMatchObject({ ok: false, code: 'not_deliverable' })
    expect(prod.real()).toHaveLength(1)

    prod.tasks.LIT2_1 = { status: 'NEW', artworks: [] }
    const id2 = await addItem('LIT2_1')
    const [ap, tick] = await Promise.all([approve(id2), tickQueue(q, deps, new Date(clock + 4 * H))])
    expect(prod.real().filter(c => c.key === 'LIT2_1')).toHaveLength(1)
    const again = await tickQueue(q, deps, new Date(clock + 5 * H))
    expect(prod.real().filter(c => c.key === 'LIT2_1')).toHaveLength(1)
    expect(['approved', 'cloud']).toContain(await statusOf(id2))
    expect(ap.ok || tick.actions.some((x: any) => x.itemId === id2)).toBe(true)
    expect(again.actions.filter((x: any) => x.itemId === id2)).toEqual([])
  })

  it('a line already delivered by an earlier run (ledger) is not sent again: status from the ledger', async () => {
    const id = await addItem('LIT1_1')
    await approve(id)
    await q.setStatus(id, 'waiting')
    const before = prod.commits.length
    const r = await approve(id)
    expect(r).toMatchObject({ ok: true, status: 'approved' })
    expect(prod.commits.length).toBe(before)
  })

  it('qa_failed (or a rejected item whose QA failed) refuses approve unless force', async () => {
    const id = await addItem('LIT1_1', { qa: { verdict: 'fail', items: ['tên tràn khung'] } })
    expect(await statusOf(id)).toBe('qa_failed')
    expect(await approve(id)).toMatchObject({ ok: false, code: 'qa_failed' })
    expect(prod.commits).toHaveLength(0)
    await rejectItem(q, id, 'xem lại')
    expect(await approve(id)).toMatchObject({ ok: false, code: 'qa_failed' })
    expect(await approve(id, { force: true })).toMatchObject({ ok: true, status: 'approved' })
    expect(await messages(id)).toMatch(/dù có lỗi QA/)
  })

  it('a fixing item cannot be approved; an unknown id says not_found', async () => {
    const id = await addItem('LIT1_1')
    await q.setStatus(id, 'fixing')
    expect(await approve(id)).toMatchObject({ ok: false, code: 'not_deliverable' })
    expect(await approve('rq_nope')).toMatchObject({ ok: false, code: 'not_found' })
    expect(prod.commits).toHaveLength(0)
  })

  it('a prod that cannot be reached leaves the item as it was, with an event', async () => {
    const id = await addItem('LIT1_1')
    const down = createDeliveryClient({ baseUrl: 'https://prod.test', token: 'w', approveToken: APPROVE, fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as any, sleep: async () => {}, budgetMs: 0 })
    const r = await approve(id, {}, { ...deps, client: down })
    expect(r).toMatchObject({ ok: false, code: 'error' })
    expect(await statusOf(id)).toBe('waiting')
    expect(await messages(id)).toMatch(/không kết nối được/)
  })
})

describe('groups', () => {
  const groupLines = () => {
    const lead = apiLine('LIT1_1')
    const later = apiLine('LIT2_1', { files: [{ kind: 'PRINT', printArea: 'Front', fileName: 'LIT1_1-front.png', mimeType: 'image/png', sharedFrom: 'LIT1_1', sharedKey: 'PRINT/Front', size: 18 }] })
    return [lead, later]
  }

  it('approves the first line, then the later line as a shortcut to the first line\'s Drive file, as one item', async () => {
    prod.tasks.LIT2_1 = { status: 'NEW', artworks: [] }
    const id = await addItem('LIT1_1', { apiLines: groupLines() })
    const r = await approve(id)
    expect(r).toMatchObject({ ok: true, status: 'approved' })
    expect(prod.uploads).toHaveLength(1)
    const later = prod.real().find(c => c.key === 'LIT2_1')
    expect(later?.body.files[0]).toMatchObject({ shortcutOf: 'D-LIT1_1-front.png-1', driveFileId: 'D-LIT1_1-front.png-1' })
    expect([prod.tasks.LIT1_1.status, prod.tasks.LIT2_1.status]).toEqual(['DONE', 'DONE'])
  })

  it('partial success → needs_look with the per-line results in an event', async () => {
    prod.tasks.LIT2_1 = { status: 'DOING', artworks: [] }
    const id = await addItem('LIT1_1', { apiLines: groupLines() })
    const r = await approve(id)
    expect(r).toMatchObject({ ok: false, status: 'needs_look' })
    expect(prod.tasks.LIT1_1.status).toBe('DONE')
    expect(prod.real().filter(c => c.key === 'LIT2_1')).toHaveLength(0)
    const text = await messages(id)
    expect(text).toMatch(/LIT1_1: đã giao/)
    expect(text).toMatch(/LIT2_1: .*DOING/)
  })
})

describe('reject, send to cloud, remove', () => {
  it('reject needs a reason, keeps the item without countdown; send to cloud delivers without approve', async () => {
    const id = await addItem('LIT1_1')
    expect(await rejectItem(q, id, '   ')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await rejectItem(q, id, 'tên lệch')).toMatchObject({ ok: true, status: 'rejected' })
    expect((await q.get(id)).statusReason).toBe('tên lệch')
    expect(await q.expired(new Date(clock + 10 * H))).toEqual([])
    const r = await sendToCloud(q, id, deps)
    expect(r).toMatchObject({ ok: true, status: 'cloud' })
    expect(prod.commits.map(c => [c.body.approve, c.header])).toEqual([[undefined, undefined]])
    expect(prod.tasks.LIT1_1.status).toBe('REVIEW')
  })

  it('remove takes an active item out (not a fixing one); nothing is sent', async () => {
    const id = await addItem('LIT1_1')
    await q.setStatus(id, 'fixing')
    expect(await removeItem(q, id)).toMatchObject({ ok: false, code: 'fixing' })
    await q.setStatus(id, 'needs_look')
    expect(await removeItem(q, id)).toMatchObject({ ok: true, status: 'removed' })
    expect(await removeItem(q, id)).toMatchObject({ ok: false, code: 'not_active' })
    expect(prod.commits).toHaveLength(0)
  })
})

describe('tickQueue', () => {
  it('after 6 h (RF 2): every expired waiting item delivered once to REVIEW, qa_failed held, rejected/fixing/fresh untouched', async () => {
    for (const k of ['LIT2_1', 'LIT3_1', 'LIT4_1', 'LIT5_1', 'LIT6_1']) prod.tasks[k] = { status: 'NEW', artworks: [] }
    const a = await addItem('LIT1_1')
    const b = await addItem('LIT2_1')
    const qa = await addItem('LIT3_1', { qa: { verdict: 'fail', items: ['tên tràn khung', 'lệch khổ'] } })
    const rej = await addItem('LIT4_1')
    await rejectItem(q, rej, 'sai màu')
    const fix = await addItem('LIT5_1')
    await q.setStatus(fix, 'fixing')
    clock += 5 * H
    const fresh = await addItem('LIT6_1')
    const r = await tickQueue(q, deps, new Date(clock + H))
    expect(r.actions.map((x: any) => [x.itemId, x.status]).sort()).toEqual([[a, 'cloud'], [b, 'cloud'], [qa, 'held']].sort())
    expect(prod.real().map(c => c.key).sort()).toEqual(['LIT1_1', 'LIT2_1'])
    expect(prod.commits.every(c => c.body.approve === undefined && c.header === undefined)).toBe(true)
    expect(holds).toEqual([['LIT3_1', expect.stringMatching(/tên tràn khung; lệch khổ/)]])
    expect(await statusOf(qa)).toBe('held')
    expect([await statusOf(rej), await statusOf(fix), await statusOf(fresh)]).toEqual(['rejected', 'fixing', 'waiting'])
    const again = await tickQueue(q, deps, new Date(clock + 2 * H))
    expect(again.actions).toEqual([])
    expect(prod.real()).toHaveLength(2)
    expect(holds).toHaveLength(1)
  })

  it('stale on delivery → needs_look; a refusal from prod → needs_look; a network failure stays waiting for the next tick', async () => {
    prod.tasks.LIT1_1.status = 'DOING'
    prod.tasks.LIT2_1 = { status: 'NEW', artworks: [] }
    const stale = await addItem('LIT1_1')
    const down = await addItem('LIT2_1')
    const offline = createDeliveryClient({ baseUrl: 'https://prod.test', token: 'w', fetchImpl: (async () => { throw new Error('ECONNRESET') }) as any, sleep: async () => {}, budgetMs: 0 })
    const r1 = await tickQueue(q, { ...deps, client: { ...prod.client, taskState: (k: string) => (k === 'LIT2_1' ? offline.taskState(k) : prod.client.taskState(k)) } }, new Date(clock + 4 * H))
    expect(await statusOf(stale)).toBe('needs_look')
    expect(await statusOf(down)).toBe('waiting')
    expect(r1.actions.find((x: any) => x.itemId === down)).toMatchObject({ ok: false, code: 'error' })
    const r2 = await tickQueue(q, deps, new Date(clock + 4 * H))
    expect(r2.actions).toEqual([expect.objectContaining({ itemId: down, status: 'cloud' })])
  })

  it('a locked item is skipped this round', async () => {
    const id = await addItem('LIT1_1')
    let release!: () => void
    const held = q.withLock(id, () => new Promise<void>(r => { release = r }))
    await new Promise(r => setTimeout(r, 20))
    const r = await tickQueue(q, deps, new Date(clock + 4 * H))
    expect(r.actions).toEqual([expect.objectContaining({ itemId: id, ok: false, code: 'locked' })])
    expect(prod.commits).toHaveLength(0)
    release()
    await held
    await tickQueue(q, deps, new Date(clock + 4 * H))
    expect(await statusOf(id)).toBe('cloud')
  })

  it('a /hold failure keeps qa_failed (reported next tick); every member key of a group is held', async () => {
    const id = await addItem('LIT1_1', { qa: { verdict: 'fail', items: ['x'] }, apiLines: [apiLine('LIT1_1'), apiLine('LIT2_1')] })
    const failing = { ...deps, hold: async () => { throw new Error('/hold trả 500') } }
    const r = await tickQueue(q, failing, new Date(clock + 4 * H))
    expect(r.actions[0]).toMatchObject({ ok: false, code: 'hold_failed' })
    expect(await statusOf(id)).toBe('qa_failed')
    await tickQueue(q, deps, new Date(clock + 4 * H))
    expect(holds.map(h => h[0])).toEqual(['LIT1_1', 'LIT2_1'])
    expect(await statusOf(id)).toBe('held')
  })
})

describe('makeHold', () => {
  it('posts { taskKey, reason } with the design agent token to /api/design-agent/runner/hold; non-2xx throws', async () => {
    const calls: any[] = []
    const answers = [json({ ok: true, jobId: 'J1' }), json({ error: 'x' }, 500)]
    const fetchImpl: any = async (url: string, init: any) => { calls.push({ url, init }); return answers.shift() }
    const hold = makeHold({ baseUrl: 'https://prod.test/', token: 'AGENT', fetchImpl, log: () => {} })
    expect(await hold('LIT1_1', 'Lỗi QA')).toEqual({ reported: true, jobId: 'J1' })
    expect(calls[0].url).toBe('https://prod.test/api/design-agent/runner/hold')
    expect(calls[0].init).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(calls[0].init.headers.Authorization).toBe('Bearer AGENT')
    expect(JSON.parse(calls[0].init.body)).toEqual({ taskKey: 'LIT1_1', reason: 'Lỗi QA' })
    expect(calls[0].init.signal).toBeTruthy()
    await expect(hold('LIT1_1', 'Lỗi QA')).rejects.toThrow(/\/hold trả 500/)
  })

  it('without a token it only logs, and the tick still marks the item held', async () => {
    const out: string[] = []
    const hold = makeHold({ baseUrl: 'https://prod.test', token: '', fetchImpl: (async () => { throw new Error('no call') }) as any, log: (m: string) => { out.push(m) } })
    expect(await hold('LIT1_1', 'Lỗi QA')).toEqual({ reported: false, jobId: null })
    expect(out.join('\n')).toMatch(/chưa cấu hình \/hold — chỉ ghi log/)
    const id = await addItem('LIT1_1', { qa: { verdict: 'fail', items: ['x'] } })
    await tickQueue(q, { ...deps, hold }, new Date(clock + 4 * H))
    expect(await statusOf(id)).toBe('held')
  })
})

describe('loadEnvFiles', () => {
  it('reads only the listed keys, strips quotes, never overrides a set variable, skips missing files', () => {
    const f = path.join(tmp, 'a.env')
    fs.writeFileSync(f, '﻿# c\nECOM_URL="https://prod.test"\nDESIGN_WORKER_TOKEN=w1\nOTHER=x\n')
    const env: any = { DESIGN_WORKER_TOKEN: 'already' }
    loadEnvFiles([{ file: f, keys: ['ECOM_URL', 'DESIGN_WORKER_TOKEN'] }, { file: path.join(tmp, 'none.env'), keys: ['X'] }], env)
    expect(env).toEqual({ ECOM_URL: 'https://prod.test', DESIGN_WORKER_TOKEN: 'already' })
  })
})

describe('tick.mjs main', () => {
  it('loads the env files without overriding, ticks the queue at REVIEW_QUEUE_ROOT, prints one line per action, exit 0', async () => {
    const home = path.join(tmp, 'home')
    fs.mkdirSync(path.join(home, '.auto-render'), { recursive: true })
    fs.writeFileSync(path.join(home, '.auto-render', 'config.env'), ['DESIGN_AGENT_TOKEN=agent', 'ECOM_URL=https://other.test', ''].join(String.fromCharCode(10)))
    const id = await addItem('LIT1_1')
    const out: string[] = []
    const env: any = { USERPROFILE: home, REVIEW_QUEUE_ROOT: path.join(tmp, 'queue'), ECOM_URL: 'https://prod.test' }
    const code = await tickMain({ env, log: (m: string) => { out.push(m) }, now: () => new Date(clock + 4 * H), deps })
    expect(code).toBe(0)
    expect(env).toMatchObject({ DESIGN_AGENT_TOKEN: 'agent', ECOM_URL: 'https://prod.test' })
    expect(out[0].startsWith(`LIT1_1 (${id}): lên cloud → cloud`)).toBe(true)
    expect(out.at(-1)).toMatch(/1 việc · lên cloud 1/)
    expect(await statusOf(id)).toBe('cloud')
  })

  it('exit 1 when the queue cannot be opened', async () => {
    const notDir = path.join(tmp, 'file')
    fs.writeFileSync(notDir, 'x')
    const out: string[] = []
    expect(await tickMain({ env: { USERPROFILE: tmp, REVIEW_QUEUE_ROOT: notDir } as any, log: (m: string) => { out.push(m) }, deps })).toBe(1)
    expect(out.join(' ')).toMatch(/không mở được hàng chờ/)
  })
})

describe('fix round 1', () => {
  const newVersion = (id: string) => q.get(id).then((it: any) => q.addOrUpdate({
    taskKey: it.taskKey, groupKey: it.groupKey, kind: it.kind, apiLines: it.apiLines,
    files: [{ part: 'PRINT_Front', kind: 'PRINT', path: it.apiLines[0].files[0].path, sha256: `new-${it.version}` }], meta: it.meta, qa: it.qa,
  }))

  it('approve needs the version the owner saw; a newer version refuses approve, cloud and reject (version_changed), nothing sent', async () => {
    const id = await addItem('LIT1_1')
    expect(await approveItem(q, id, deps)).toMatchObject({ ok: false, code: 'version_required' })
    await newVersion(id)
    expect(await approveItem(q, id, deps, { version: 1 })).toMatchObject({ ok: false, code: 'version_changed', version: 2 })
    expect(await sendToCloud(q, id, deps, { version: 1 })).toMatchObject({ ok: false, code: 'version_changed' })
    expect(await rejectItem(q, id, 'x', { version: 1 })).toMatchObject({ ok: false, code: 'version_changed' })
    expect(prod.commits).toHaveLength(0)
    expect(await statusOf(id)).toBe('waiting')
    expect(await rejectItem(q, id, 'x', { version: 2 })).toMatchObject({ ok: true, status: 'rejected' })
    expect(await approveItem(q, id, deps, { version: 2 })).toMatchObject({ ok: true, status: 'approved' })
  })

  it('tick: a 5xx answer or drive_missing / wrong_folder / size_mismatch keeps the item waiting for the next tick', async () => {
    for (const answer of [
      { ok: false, status: 500, body: { error: 'boom' } },
      { ok: false, status: 400, body: { code: 'drive_missing', error: 'không thấy file' } },
      { ok: false, status: 400, body: { code: 'wrong_folder', error: 'sai thư mục' } },
      { ok: false, status: 400, body: { code: 'size_mismatch', error: 'sai dung lượng' } },
    ]) {
      const id = await addItem('LIT1_1')
      const r = await tickQueue(q, { ...deps, client: { ...prod.client, commit: async () => answer } }, new Date(clock + 4 * H))
      expect(r.actions).toEqual([expect.objectContaining({ itemId: id, ok: false, code: 'refused' })])
      expect(await statusOf(id)).toBe('waiting')
      await q.setStatus(id, 'removed')
    }
    const id = await addItem('LIT1_1', { line: { files: [{ kind: 'PRINT', printArea: 'Front', path: file('again.png'), fileName: 'again.png', mimeType: 'image/png' }] } })
    await tickQueue(q, deps, new Date(clock + 4 * H))
    expect(await statusOf(id)).toBe('cloud')
  })

  it('an error after part of a group was delivered → needs_look "đã giao một phần"', async () => {
    prod.tasks.LIT2_1 = { status: 'NEW', artworks: [] }
    const later = apiLine('LIT2_1', { files: [{ kind: 'PRINT', printArea: 'Front', fileName: 'LIT1_1-front.png', mimeType: 'image/png', sharedFrom: 'LIT1_1', sharedKey: 'PRINT/Front', size: 18 }] })
    const id = await addItem('LIT1_1', { apiLines: [apiLine('LIT1_1'), later] })
    const broken = { ...prod.client, commit: (k: string, b: any) => (k === 'LIT2_1' ? Promise.reject(new DeliveryGaveUp('prod không trả lời')) : prod.client.commit(k, b)) }
    const r = await approve(id, {}, { ...deps, client: broken })
    expect(r).toMatchObject({ ok: false, code: 'needs_look', status: 'needs_look' })
    expect(prod.tasks.LIT1_1.status).toBe('DONE')
    expect(await statusOf(id)).toBe('needs_look')
    expect(await messages(id)).toMatch(/đã giao một phần: LIT1_1/)
  })

  it('an item with no api lines is never approved', async () => {
    const r0 = await q.addOrUpdate({ taskKey: 'LIT1_1', groupKey: 'LIT1_1', kind: 'line', apiLines: [], files: [], meta: { ledgerPath }, qa: { verdict: 'pass', items: [] } })
    const r = await approve(r0.itemId)
    expect(r).toMatchObject({ ok: false, code: 'error' })
    expect(await statusOf(r0.itemId)).toBe('waiting')
    expect(prod.commits).toHaveLength(0)
  })

  it('a retry after a partial /hold failure reports only the keys not reported yet', async () => {
    const id = await addItem('LIT1_1', { qa: { verdict: 'fail', items: ['x'] }, apiLines: [apiLine('LIT1_1'), apiLine('LIT2_1')] })
    const flaky = { ...deps, hold: async (k: string, reason: string) => { if (k === 'LIT2_1') throw new Error('/hold trả 502'); holds.push([k, reason]); return { reported: true, jobId: null } } }
    expect((await tickQueue(q, flaky, new Date(clock + 4 * H))).actions[0]).toMatchObject({ ok: false, code: 'hold_failed' })
    await tickQueue(q, deps, new Date(clock + 4 * H))
    expect(holds.map(h => h[0])).toEqual(['LIT1_1', 'LIT2_1'])
    expect(await statusOf(id)).toBe('held')
  })

  it('live deps pass the retry budget to the client; the tick uses 5 minutes', async () => {
    expect(TICK_BUDGET_MS).toBe(300_000)
    let t = 0
    const waits: number[] = []
    const live = makeLiveDeps({
      env: { ECOM_URL: 'https://prod.test', DESIGN_WORKER_TOKEN: 'w' } as any, log: () => {},
      fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as any,
      budgetMs: TICK_BUDGET_MS, sleep: async (ms: number) => { waits.push(ms); t += ms }, now: () => t,
    })
    await expect(live.client.taskState('K')).rejects.toBeInstanceOf(DeliveryGaveUp)
    const total = waits.reduce((a, b) => a + b, 0)
    expect(total).toBeLessThanOrEqual(300_000)
    expect(total).toBeGreaterThan(200_000)
  })
})
