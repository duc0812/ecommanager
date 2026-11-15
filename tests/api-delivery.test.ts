import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runApiDelivery } from '../scripts/lib/api-delivery.mjs'
import { createUploader } from '../scripts/lib/delivery-drive-upload.mjs'
import { DeliveryGaveUp, DeliveryStopped } from '../scripts/lib/delivery-client.mjs'

let dir: string
let ledgerPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-deliv-'))
  ledgerPath = path.join(dir, 'ledger.json')
})

const localFile = (name: string, size = 10) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, Buffer.alloc(size, 7))
  return p
}

function fakes(opts: { commit?: (key: string, body: any) => any; state?: any } = {}) {
  const events: string[] = []
  const commits: { key: string; body: any }[] = []
  const uploads: any[] = []
  const state = opts.state ?? { status: 'DOING', incomingFolder: { id: 'INC' }, artworks: [{ id: 'a1' }, { id: 'a2' }] }
  const client: any = {
    taskState: async (key: string) => { events.push(`state ${key}`); return { ok: true, status: 200, body: state } },
    commit: async (key: string, body: any) => {
      events.push(`commit ${key}`)
      commits.push({ key, body })
      if (opts.commit) return opts.commit(key, body)
      return {
        ok: true, status: 200,
        body: { ok: true, status: 'REVIEW', artworks: body.files.map((f: any, i: number) => ({ id: `n${i}`, kind: f.kind, printArea: f.printArea, driveFileId: f.driveFileId })), alreadyApplied: false },
      }
    },
    putPreview: async (id: string) => { events.push(`preview ${id}`); return { ok: true, status: 200, body: {} } },
  }
  const uploader = {
    upload: async (a: any) => { events.push(`upload ${a.name}`); uploads.push(a); return { id: `D-${a.name}`, size: fs.statSync(a.path).size } },
  }
  return { client, uploader, events, commits, uploads, state }
}

const line = (extra: any = {}) => ({
  taskKey: 'LIT1_1', action: 'push', retire: [],
  files: [
    { kind: 'PRINT', printArea: 'Front', path: localFile('front.png'), fileName: 'front.png', mimeType: 'image/png', widthPx: 100, heightPx: 200 },
    { kind: 'PRINT', printArea: 'back', path: localFile('back.png'), fileName: 'back.png', mimeType: 'image/png', widthPx: 0 },
  ],
  ...extra,
})
const run = (f: ReturnType<typeof fakes>, lines: any[], extra: any = {}) =>
  runApiDelivery({ lines, client: f.client, uploader: f.uploader, ledgerPath, log: () => {}, ...extra })
const ledger = () => JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
const entries = (task = 'LIT1_1') => Object.entries(ledger().lines).filter(([k]) => k.startsWith(`${task}#`)).map(([, v]) => v as any)
const entry = (task = 'LIT1_1') => entries(task)[0]

describe('runApiDelivery', () => {
  it('uploads into the incoming folder, commits with expected state, files sorted case-insensitively, unknown sizes null', async () => {
    const f = fakes()
    const r = await run(f, [line()])
    expect(r).toMatchObject({ applied: 1, skipped: 0, alreadyApplied: 0 })
    expect(f.uploads.every(u => u.parentId === 'INC')).toBe(true)
    const body = f.commits[0].body
    expect(body.expected).toEqual({ status: 'DOING', liveIds: ['a1', 'a2'] })
    expect(body.files.map((x: any) => x.printArea)).toEqual(['back', 'Front'])
    expect(body.files[0]).toMatchObject({ widthPx: null, heightPx: null, driveFileId: 'D-back.png' })
    expect(body.files[1]).toMatchObject({ widthPx: 100, heightPx: 200 })
    expect(entry().applied).toBeTruthy()
  })

  it('skips an applied line on a second run: no upload, no commit, not even a state read', async () => {
    const l = line()
    await run(fakes(), [l])
    const g = fakes()
    const r = await run(g, [l])
    expect(r).toMatchObject({ applied: 0, alreadyApplied: 1 })
    expect(g.events).toEqual([])
  })

  it('a crash between upload and commit is resumed without uploading again', async () => {
    const crashing = fakes({ commit: () => { throw new DeliveryGaveUp('down', { status: 503 }) } })
    const l = line()
    await expect(run(crashing, [l])).rejects.toBeInstanceOf(DeliveryGaveUp)
    expect(crashing.uploads).toHaveLength(2)
    const led = entry()
    expect(led.applied).toBeFalsy()
    expect(Object.values(led.files).map((x: any) => x.driveFileId).sort()).toEqual(['D-back.png', 'D-front.png'])
    const second = fakes()
    const r = await run(second, [l])
    expect(second.uploads).toHaveLength(0)
    expect(r.applied).toBe(1)
    expect(second.commits[0].body.files.map((x: any) => x.driveFileId).sort()).toEqual(['D-back.png', 'D-front.png'])
  })

  it('writes the ledger after each upload, before the commit, atomically', async () => {
    let snapshot: any = null
    const f = fakes({ commit: () => { snapshot = ledger(); return { ok: true, status: 200, body: { ok: true, artworks: [], alreadyApplied: false } } } })
    await run(f, [line()])
    expect(Object.keys((Object.values(snapshot.lines)[0] as any).files)).toHaveLength(2)
    expect((Object.values(snapshot.lines)[0] as any).applied).toBeFalsy()
    expect(fs.existsSync(`${ledgerPath}.tmp`)).toBe(false)
  })

  it('a changed local file is a new delivery: everything is uploaded again, the old copy stays on Drive', async () => {
    const crashing = fakes({ commit: () => { throw new DeliveryGaveUp('down', { status: 503 }) } })
    const l = line()
    await expect(run(crashing, [l])).rejects.toBeInstanceOf(DeliveryGaveUp)
    fs.writeFileSync(l.files[0].path, Buffer.alloc(55, 9))
    const second = fakes()
    await run(second, [l])
    expect(second.uploads.map(u => u.name).sort()).toEqual(['back.png', 'front.png'])
  })

  it('on a 409 re-reads state, records skippedOnProd, and never deletes on Drive', async () => {
    const f = fakes({ commit: () => ({ ok: false, status: 409, body: { error: 'đã đổi', code: 'stale_state' } }) })
    const r = await run(f, [line()])
    expect(r).toMatchObject({ applied: 0, skipped: 1 })
    expect(f.events.filter(e => e === 'state LIT1_1')).toHaveLength(2)
    expect(entry().skippedOnProd).toEqual({ code: 'stale_state', error: 'đã đổi', status: 409 })
    expect(entry().applied).toBeFalsy()
  })

  it('records 400 and 404 in the ledger; a 400 counts as failed, a 404 as skipped', async () => {
    for (const [status, counted, outcome] of [[400, 'failed', 'failed'], [404, 'skipped', 'skipped']] as const) {
      fs.rmSync(ledgerPath, { force: true })
      const f = fakes({ commit: () => ({ ok: false, status, body: { error: 'nope', code: 'bad' } }) })
      const r: any = await run(f, [line()])
      expect(r[counted]).toBe(1)
      expect(r.results[0]).toMatchObject({ outcome, status })
      expect(entry().skippedOnProd.status).toBe(status)
    }
  })

  const state = (status: string, artworks: any[] = []) => ({ status, incomingFolder: { id: 'INC' }, artworks })
  const auto = (...ids: string[]) => ids.map(id => ({ id, kind: 'PRINT', printArea: id, source: 'AUTO', driveFileId: `D-${id}` }))

  it('skips a line as stale before any upload or commit when the task is not in the expected status', async () => {
    const f = fakes({ state: state('DOING') })
    const r = await run(f, [line({ expectedStatus: 'NEW' })])
    expect(r).toMatchObject({ skipped: 1, applied: 0, failed: 0 })
    expect(f.uploads).toHaveLength(0)
    expect(f.commits).toHaveLength(0)
    expect(r.results[0]).toMatchObject({ outcome: 'skipped', ok: false, body: { code: 'stale' } })
    expect(r.results[0].body.error).toMatch(/DOING.*NEW/)
    expect(entry().skippedOnProd).toMatchObject({ code: 'stale' })
    expect(entry().applied).toBeFalsy()
  })

  it('takes a list of expected statuses', async () => {
    const f = fakes({ state: state('DOING') })
    expect(await run(f, [line({ expectedStatus: ['REVIEW', 'DOING'] })])).toMatchObject({ applied: 1 })
  })

  it('still sends a commit whose files are already live after a lost response, whatever the status', async () => {
    const l = line({ expectedStatus: 'NEW' })
    await expect(run(fakes({ state: state('NEW'), commit: () => { throw new DeliveryGaveUp('lost', { status: 504 }) } }), [l])).rejects.toBeInstanceOf(DeliveryGaveUp)
    const live = [{ id: 'n1', kind: 'PRINT', printArea: 'Front', driveFileId: 'D-front.png' }, { id: 'n2', kind: 'PRINT', printArea: 'back', driveFileId: 'D-back.png' }]
    const f = fakes({ state: state('REVIEW', live), commit: () => ({ ok: true, status: 200, body: { ok: true, status: 'REVIEW', artworks: live, alreadyApplied: true } }) })
    expect(await run(f, [l])).toMatchObject({ applied: 1 })
    expect(f.uploads).toHaveLength(0)
    expect(f.commits).toHaveLength(1)
  })

  it('push, then revert, then the same push again: the second push is sent', async () => {
    const push = line({ expectedStatus: 'NEW' })
    const revert = { taskKey: 'LIT1_1', action: 'revert', files: [], retire: [], revertReadiness: 'LOW', expectedStatus: 'REVIEW', planIds: ['n0', 'n1'] }
    await run(fakes({ state: state('NEW') }), [push])
    expect((await run(fakes({ state: state('REVIEW', auto('n0', 'n1')) }), [revert])).applied).toBe(1)
    const f = fakes({ state: state('NEW') })
    expect(await run(f, [push])).toMatchObject({ applied: 1, alreadyApplied: 0 })
    expect(f.uploads).toHaveLength(2)
    expect(f.commits[0].body.action).toBe('push')
  })

  it('two reverts at different times are both sent, even with the same plan ids', async () => {
    const push = line({ expectedStatus: 'NEW' })
    const revert = { taskKey: 'LIT1_1', action: 'revert', files: [], retire: [], revertReadiness: 'LOW', expectedStatus: 'REVIEW', planIds: ['n0'] }
    await run(fakes({ state: state('NEW') }), [push])
    await run(fakes({ state: state('REVIEW', auto('n0')) }), [revert])
    await run(fakes({ state: state('NEW') }), [push])
    const f = fakes({ state: state('REVIEW', auto('n0')) })
    expect(await run(f, [revert])).toMatchObject({ applied: 1, alreadyApplied: 0 })
    expect(f.commits.map(c => c.body.action)).toEqual(['revert'])
  })

  function server(start: { status: string; artworks: any[] }) {
    const db = { status: start.status, artworks: [...start.artworks] }
    const f = fakes()
    f.client.taskState = async (key: string) => { f.events.push(`state ${key}`); return { ok: true, status: 200, body: state(db.status, db.artworks.map(a => ({ ...a }))) } }
    f.client.commit = async (key: string, body: any) => {
      f.events.push(`commit ${key}`)
      f.commits.push({ key, body })
      if (body.action === 'revert') {
        db.artworks = db.artworks.filter(a => a.source !== 'AUTO')
        db.status = 'NEW'
      } else {
        db.artworks = db.artworks.filter(a => !(body.retire ?? []).includes(a.id))
        db.artworks.push(...body.files.map((x: any) => ({ id: `art-${x.driveFileId}`, kind: x.kind, printArea: x.printArea, source: 'AUTO', driveFileId: x.driveFileId })))
        db.status = 'REVIEW'
      }
      return { ok: true, status: 200, body: { ok: true, status: db.status, artworks: db.artworks, alreadyApplied: false } }
    }
    return { f, db }
  }

  it('P1, revert V1, P2, then V1 again: the re-sent revert is stale and P2 stays live', async () => {
    const { f, db } = server({ status: 'NEW', artworks: [] })
    const go = (l: any) => runApiDelivery({ lines: [l], client: f.client, uploader: f.uploader, ledgerPath, log: () => {} })
    const p1 = line({ expectedStatus: 'NEW' })
    expect((await go(p1)).applied).toBe(1)
    const v1 = { taskKey: 'LIT1_1', action: 'revert', files: [], retire: [], revertReadiness: 'LOW', expectedStatus: 'REVIEW', planIds: db.artworks.map(a => a.id) }
    expect((await go(v1)).applied).toBe(1)
    expect(db).toMatchObject({ status: 'NEW', artworks: [] })
    const p2 = line({ expectedStatus: 'NEW', files: [{ kind: 'PRINT', printArea: 'Front', path: localFile('p2.png'), fileName: 'p2.png', mimeType: 'image/png' }] })
    expect((await go(p2)).applied).toBe(1)
    const live = db.artworks.map(a => a.id)
    expect(live).toEqual(['art-D-p2.png'])
    const commitsBefore = f.commits.length
    const r = await go(v1)
    expect(r).toMatchObject({ skipped: 1, applied: 0, alreadyApplied: 0 })
    expect(r.results[0].body).toMatchObject({ code: 'stale' })
    expect(r.results[0].body.error).toMatch(/kế hoạch cũ — lập lại kế hoạch từ snapshot mới/)
    expect(f.commits).toHaveLength(commitsBefore)
    expect(db).toMatchObject({ status: 'REVIEW' })
    expect(db.artworks.map(a => a.id)).toEqual(live)
  })

  it('a replace re-sent after a later replace uploads nothing and is skipped as stale', async () => {
    const { f, db } = server({ status: 'REVIEW', artworks: auto('a1') })
    const go = (l: any) => runApiDelivery({ lines: [l], client: f.client, uploader: f.uploader, ledgerPath, log: () => {} })
    const r1 = { taskKey: 'LIT1_1', action: 'replace', expectedStatus: 'REVIEW', retire: ['a1'], planIds: ['a1'],
      files: [{ kind: 'PRINT', printArea: 'a1', path: localFile('r1.png'), fileName: 'r1.png', mimeType: 'image/png' }] }
    expect((await go(r1)).applied).toBe(1)
    const r2 = { taskKey: 'LIT1_1', action: 'replace', expectedStatus: 'REVIEW', retire: ['art-D-r1.png'], planIds: ['art-D-r1.png'],
      files: [{ kind: 'PRINT', printArea: 'a1', path: localFile('r2.png'), fileName: 'r2.png', mimeType: 'image/png' }] }
    expect((await go(r2)).applied).toBe(1)
    const uploadsBefore = f.uploads.length
    const commitsBefore = f.commits.length
    const r = await go(r1)
    expect(r).toMatchObject({ skipped: 1, applied: 0 })
    expect(r.results[0].body.code).toBe('stale')
    expect(f.uploads).toHaveLength(uploadsBefore)
    expect(f.commits).toHaveLength(commitsBefore)
    expect(db.artworks.map(a => a.id)).toEqual(['art-D-r2.png'])
  })

  it('a retire whose ids are no longer live is stale', async () => {
    const f = fakes({ state: state('REVIEW', auto('x1')) })
    const r = await run(f, [{ taskKey: 'T', action: 'retire', files: [], retire: ['gone'], expectedStatus: 'REVIEW' }])
    expect(r.skipped).toBe(1)
    expect(f.commits).toHaveLength(0)
  })

  it('the delivery key covers the expected status and the plan ids', async () => {
    await run(fakes({ state: state('REVIEW', auto('a')) }), [{ taskKey: 'V', action: 'revert', files: [], retire: [], expectedStatus: 'REVIEW', planIds: ['a'] }])
    const f = fakes({ state: state('REVIEW', auto('b')) })
    await run(f, [{ taskKey: 'V', action: 'revert', files: [], retire: [], expectedStatus: 'REVIEW', planIds: ['b'] }])
    expect(f.commits).toHaveLength(1)
    expect(entries('V')).toHaveLength(2)
  })

  it('stops the whole run on DeliveryGaveUp', async () => {
    const f = fakes()
    f.client.taskState = async () => { throw new DeliveryGaveUp('gone', { status: 503 }) }
    await expect(run(f, [line({ taskKey: 'A' }), line({ taskKey: 'B' })])).rejects.toBeInstanceOf(DeliveryGaveUp)
    expect(f.uploads).toHaveLength(0)
  })

  it('does not upload shortcutOf files and sends them with the target id', async () => {
    const f = fakes()
    await run(f, [line({ files: [{ kind: 'PRINT', printArea: 'Front', path: localFile('s.png'), fileName: 's.png', mimeType: 'image/png', widthPx: 1, heightPx: 1, shortcutOf: 'TARGET' }] })])
    expect(f.uploads).toHaveLength(0)
    expect(f.commits[0].body.files[0]).toMatchObject({ driveFileId: 'TARGET', shortcutOf: 'TARGET' })
  })

  it('passes retire and revert fields through for file-less actions', async () => {
    const f = fakes()
    await run(f, [{ taskKey: 'R', action: 'retire', files: [], retire: ['a1'], retireSources: ['AUTO'], eventMessage: 'm', allowFinished: true }])
    expect(f.commits[0].body).toMatchObject({ action: 'retire', retire: ['a1'], retireSources: ['AUTO'], eventMessage: 'm', allowFinished: true, files: [] })
    await run(f, [{ taskKey: 'V', action: 'revert', files: [], retire: [], revertReadiness: 'LOW' }])
    expect(f.commits[1].body).toMatchObject({ action: 'revert', revertReadiness: 'LOW' })
  })

  it('puts a preview for committed PRINT files of 30 MB or more; a failure is not fatal', async () => {
    const big = localFile('huge.png', 30 * 1024 * 1024)
    const f = fakes()
    f.client.putPreview = async (id: string) => { f.events.push(`preview ${id}`); return { ok: false, status: 500, body: {} } }
    const previewOf = async (p: string) => (p === big ? Buffer.from([0xff, 0xd8, 0xff]) : null)
    const r = await run(f, [line({ files: [
      { kind: 'PRINT', printArea: 'Front', path: big, fileName: 'huge.png', mimeType: 'image/png', widthPx: 1, heightPx: 1 },
      { kind: 'PRINT', printArea: 'Back', path: localFile('small.png'), fileName: 'small.png', mimeType: 'image/png', widthPx: 1, heightPx: 1 },
    ] })], { previewOf })
    expect(r.applied).toBe(1)
    expect(f.events.filter(e => e.startsWith('preview'))).toHaveLength(1)
    expect(entry().pendingPreviews).toHaveLength(1)
  })

  it('keys the ledger per delivery: a replace after a push is sent; rerun, the replace is done and the old push is stale', async () => {
    const st = (status: string) => ({ status, incomingFolder: { id: 'INC' }, artworks: [{ id: 'a1' }] })
    const push = line({ expectedStatus: 'NEW' })
    await run(fakes({ state: st('NEW') }), [push])
    const replaceLine = { ...push, action: 'replace', retire: ['a1'], expectedStatus: 'REVIEW' }
    const g = fakes({ state: st('REVIEW') })
    const r = await run(g, [replaceLine])
    expect(r.applied).toBe(1)
    expect(g.commits[0].body.action).toBe('replace')
    const h = fakes({ state: st('REVIEW') })
    const again = await run(h, [push, replaceLine])
    expect(again).toMatchObject({ applied: 0, alreadyApplied: 1, skipped: 1 })
    expect(h.uploads).toHaveLength(0)
    expect(h.commits).toHaveLength(0)
    expect(entries()).toHaveLength(2)
  })

  it('stops before any upload when the ledger is corrupt, and leaves the file untouched', async () => {
    fs.writeFileSync(ledgerPath, '{"lines": {"LIT1_1#x": {"files": {')
    const before = fs.readFileSync(ledgerPath, 'utf8')
    const f = fakes()
    await expect(run(f, [line()])).rejects.toThrow(/hỏng/)
    expect(f.events).toEqual([])
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(before)
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false)
  })

  it('treats only a missing ledger as empty; an unreadable path is an error', async () => {
    fs.mkdirSync(ledgerPath)
    await expect(run(fakes(), [line()])).rejects.toThrow()
  })

  it('refuses to run while the lock exists and removes its own lock afterwards', async () => {
    fs.writeFileSync(`${ledgerPath}.lock`, String(process.pid))
    await expect(run(fakes(), [line()])).rejects.toThrow(/khác/)
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(true)
    fs.rmSync(`${ledgerPath}.lock`)
    await run(fakes(), [line()])
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false)
    const crashing = fakes({ commit: () => { throw new DeliveryGaveUp('down', { status: 503 }) } })
    await expect(run(crashing, [line({ taskKey: 'Z' })])).rejects.toBeInstanceOf(DeliveryGaveUp)
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false)
  })

  it('takes over a lock whose process is gone, and says so', async () => {
    const dead = 2 ** 22 + 12345
    expect(() => process.kill(dead, 0)).toThrow()
    fs.writeFileSync(`${ledgerPath}.lock`, String(dead))
    const logs: string[] = []
    const r = await run(fakes(), [line()], { log: (m: string) => logs.push(m) })
    expect(r).toMatchObject({ applied: 1 })
    expect(logs.some(m => m.includes(String(dead)) && m.includes('khóa'))).toBe(true)
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false)
  })

  it('refuses a lock without a readable pid, as before', async () => {
    fs.writeFileSync(`${ledgerPath}.lock`, 'garbage')
    await expect(run(fakes(), [line()])).rejects.toThrow(/khác/)
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(true)
  })

  it.each(['drive_missing', 'wrong_folder', 'size_mismatch'])('a commit answered %s drops the cached file ids so the next run uploads again', async code => {
    const l = line()
    const bad = fakes({ commit: () => ({ ok: false, status: 400, body: { ok: false, code, error: 'x' } }) })
    expect(await run(bad, [l])).toMatchObject({ failed: 1 })
    expect(bad.uploads).toHaveLength(2)
    expect(Object.values(entry().files).some((e: any) => e?.driveFileId)).toBe(false)
    const again = fakes()
    expect(await run(again, [l])).toMatchObject({ applied: 1 })
    expect(again.uploads).toHaveLength(2)
  })

  it('another refusal keeps the cached file ids, so the next run does not upload again', async () => {
    const l = line()
    await run(fakes({ commit: () => ({ ok: false, status: 400, body: { ok: false, code: 'old_layout', error: 'x' } }) }), [l])
    const again = fakes()
    await run(again, [l])
    expect(again.uploads).toHaveLength(0)
  })

  it('retries the ledger rename on EPERM', async () => {
    const real = fs.renameSync
    let failures = 2
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((a: any, b: any) => {
      if (failures-- > 0) throw Object.assign(new Error('locked'), { code: 'EPERM' })
      return real(a, b)
    })
    try {
      await run(fakes(), [line()])
    } finally {
      spy.mockRestore()
    }
    expect(entry().applied).toBeTruthy()
  })

  it('fsyncs the temporary ledger before renaming it', async () => {
    const order: string[] = []
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { order.push('fsync') })
    const real = fs.renameSync
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((a: any, b: any) => { order.push('rename'); return real(a, b) })
    try {
      await run(fakes(), [line({ files: [], action: 'retire', retire: ['a1'] })])
    } finally {
      fsync.mockRestore()
      rename.mockRestore()
    }
    expect(order.indexOf('fsync')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('fsync')).toBeLessThan(order.indexOf('rename'))
  })

  it('waits for every running upload before the line ends when one fails', async () => {
    const f = fakes()
    let slowDone = false
    f.uploader.upload = async (a: any) => {
      if (a.name === 'back.png') throw new Error('disk gone')
      await new Promise(r => setTimeout(r, 30))
      slowDone = true
      return { id: `D-${a.name}`, size: 10 }
    }
    const r = await run(f, [line()])
    expect(r.failed).toBe(1)
    expect(slowDone).toBe(true)
    expect(f.commits).toHaveLength(0)
    expect(Object.keys(entry().files)).toEqual(['PRINT/Front'])
  })

  it('sends only positive integer sizes, otherwise null', async () => {
    const f = fakes()
    await run(f, [line({ files: [
      { kind: 'PRINT', printArea: 'A', path: localFile('a.png'), fileName: 'a.png', mimeType: 'image/png', widthPx: 1.5, heightPx: -3 },
      { kind: 'PRINT', printArea: 'B', path: localFile('b.png'), fileName: 'b.png', mimeType: 'image/png', widthPx: 640, heightPx: 480 },
    ] })])
    expect(f.commits[0].body.files.map((x: any) => [x.widthPx, x.heightPx])).toEqual([[null, null], [640, 480]])
  })

  it('takes a shortcut size from the file spec, else the local file, else fails the line', async () => {
    const f = fakes()
    await run(f, [line({ files: [{ kind: 'PRINT', printArea: 'Front', path: path.join(dir, 'gone.png'), fileName: 'g.png', mimeType: 'image/png', shortcutOf: 'T', size: 4321 }] })])
    expect(f.commits[0].body.files[0].size).toBe(4321)
    const g = fakes()
    const r = await run(g, [line({ taskKey: 'S2', files: [{ kind: 'PRINT', printArea: 'Front', path: path.join(dir, 'gone.png'), fileName: 'g.png', mimeType: 'image/png', shortcutOf: 'T' }] })])
    expect(r.failed).toBe(1)
    expect(g.commits).toHaveLength(0)
  })

  it('matches previews by driveFileId and drops the entry on 404 but keeps it on 500', async () => {
    const big = localFile('huge.png', 30 * 1024 * 1024)
    const mk = (status: number) => {
      const f = fakes({ commit: (_k, body) => ({ ok: true, status: 200, body: { ok: true, alreadyApplied: false, artworks: [
        { id: 'WRONG', kind: 'PRINT', printArea: 'Front', driveFileId: 'someone-else' },
        { id: 'RIGHT', kind: 'PRINT', printArea: 'renamed-by-server', driveFileId: body.files[0].driveFileId },
      ] } }) })
      f.client.putPreview = async (id: string) => { f.events.push(`preview ${id}`); return { ok: false, status, body: {} } }
      return f
    }
    const l = line({ files: [{ kind: 'PRINT', printArea: 'Front', path: big, fileName: 'huge.png', mimeType: 'image/png', widthPx: 1, heightPx: 1 }] })
    const previewOf = async () => Buffer.from([0xff, 0xd8, 0xff])
    const f404 = mk(404)
    await run(f404, [l], { previewOf })
    expect(f404.events.filter(e => e.startsWith('preview'))).toEqual(['preview RIGHT'])
    expect(entry().pendingPreviews).toEqual([])
    fs.rmSync(ledgerPath)
    const f500 = mk(500)
    await run(f500, [l], { previewOf })
    expect(entry().pendingPreviews).toHaveLength(1)
  })

  it('stops the whole run on DeliveryStopped', async () => {
    const f = fakes()
    f.client.taskState = async () => { throw new DeliveryStopped('401', { status: 401 }) }
    await expect(run(f, [line({ taskKey: 'A' }), line({ taskKey: 'B' })])).rejects.toBeInstanceOf(DeliveryStopped)
  })

  it('dryRun uploads and records the ids, sends the commit with dryRun, never marks applied nor sends a preview', async () => {
    const big = localFile('huge.png', 30 * 1024 * 1024)
    const l = line({ files: [{ kind: 'PRINT', printArea: 'Front', path: big, fileName: 'huge.png', mimeType: 'image/png', widthPx: 1, heightPx: 1 }] })
    const f = fakes()
    const previewOf = async () => Buffer.from([0xff, 0xd8, 0xff])
    const r = await run(f, [l], { dryRun: true, previewOf })
    expect(r).toMatchObject({ applied: 0, dryRun: 1, skipped: 0, failed: 0 })
    expect(f.uploads).toHaveLength(1)
    expect(f.commits[0].body.dryRun).toBe(true)
    expect(f.events.some(e => e.startsWith('preview'))).toBe(false)
    expect(entry().applied).toBeFalsy()
    expect(entry().files['PRINT/Front'].driveFileId).toBe('D-huge.png')
    expect(r.results).toEqual([expect.objectContaining({ taskKey: 'LIT1_1', ok: true, status: 200, outcome: 'dryRun' })])
    expect(r.results[0].key).toMatch(/^LIT1_1#/)
    const real = fakes()
    const again = await run(real, [l], { previewOf })
    expect(real.uploads).toHaveLength(0)
    expect(real.commits[0].body.dryRun).toBeUndefined()
    expect(again).toMatchObject({ applied: 1, dryRun: 0 })
    expect(entry().applied).toBeTruthy()
  })

  it('dryRun on an applied line reports alreadyApplied and sends no pending preview', async () => {
    const big = localFile('huge.png', 30 * 1024 * 1024)
    const l = line({ files: [{ kind: 'PRINT', printArea: 'Front', path: big, fileName: 'huge.png', mimeType: 'image/png', widthPx: 1, heightPx: 1 }] })
    const first = fakes()
    first.client.putPreview = async () => ({ ok: false, status: 500, body: {} })
    await run(first, [l], { previewOf: async () => Buffer.from([1]) })
    expect(entry().pendingPreviews).toHaveLength(1)
    const dry = fakes()
    const r = await run(dry, [l], { dryRun: true, previewOf: async () => Buffer.from([1]) })
    expect(r).toMatchObject({ alreadyApplied: 1 })
    expect(r.results[0]).toMatchObject({ taskKey: 'LIT1_1', ok: true, outcome: 'alreadyApplied' })
    expect(dry.events).toEqual([])
    expect(entry().pendingPreviews).toHaveLength(1)
  })

  it('returns one result per line: applied, refused on prod, failed', async () => {
    const f = fakes({ commit: (key) => key === 'NO'
      ? { ok: false, status: 409, body: { error: 'đã đổi', code: 'stale_state' } }
      : { ok: true, status: 200, body: { ok: true, status: 'REVIEW', artworks: [], alreadyApplied: false } } })
    const broken = line({ taskKey: 'BAD', files: [{ kind: 'PRINT', printArea: 'Front', path: path.join(dir, 'gone.png'), fileName: 'g.png', mimeType: 'image/png', shortcutOf: 'T' }] })
    const r = await run(f, [line({ taskKey: 'OK' }), line({ taskKey: 'NO' }), broken])
    expect(r).toMatchObject({ applied: 1, skipped: 1, failed: 1 })
    expect(r.results.map((x: any) => [x.taskKey, x.ok, x.status, x.outcome])).toEqual([
      ['OK', true, 200, 'applied'],
      ['NO', false, 409, 'skipped'],
      ['BAD', false, null, 'failed'],
    ])
    expect(r.results[1].body).toMatchObject({ code: 'stale_state' })
    expect(r.results[2].body.error).toMatch(/dung lượng/)
  })

  it('a refused task state is a skipped result with its status', async () => {
    const f = fakes()
    f.client.taskState = async () => ({ ok: false, status: 404, body: { error: 'không có', code: 'not_found' } })
    const r = await run(f, [line()])
    expect(r.results[0]).toMatchObject({ ok: false, status: 404, outcome: 'skipped', body: { code: 'not_found' } })
  })

  it('a file with a knownDriveFileId is committed with that id, without an upload', async () => {
    const f = fakes()
    const r = await run(f, [line({ files: [{ kind: 'PRINT', printArea: 'Front', path: localFile('known.png', 33), fileName: 'known.png', mimeType: 'image/png', knownDriveFileId: 'KNOWN1' }] })])
    expect(r.applied).toBe(1)
    expect(f.uploads).toHaveLength(0)
    expect(f.commits[0].body.files[0]).toMatchObject({ driveFileId: 'KNOWN1', size: 33 })
    expect(f.commits[0].body.files[0].shortcutOf).toBeUndefined()
  })

  it('a known id without a local copy takes its size from the spec', async () => {
    const f = fakes()
    await run(f, [line({ files: [{ kind: 'PRINT', printArea: 'Front', fileName: 'front.png', mimeType: 'image/png', size: 777, knownDriveFileId: 'KNOWN1' }] })])
    expect(f.uploads).toHaveLength(0)
    expect(f.commits[0].body.files[0]).toMatchObject({ driveFileId: 'KNOWN1', size: 777 })
  })

  it.each(['wrong_folder', 'drive_missing'])('after %s on a known id the next run uploads from the local path', async code => {
    const l = line({ files: [{ kind: 'PRINT', printArea: 'Front', path: localFile('front.png'), fileName: 'front.png', mimeType: 'image/png', knownDriveFileId: 'KNOWN1' }] })
    const bad = fakes({ commit: () => ({ ok: false, status: 400, body: { ok: false, code, error: 'x' } }) })
    expect(await run(bad, [l])).toMatchObject({ failed: 1 })
    expect(bad.uploads).toHaveLength(0)
    const again = fakes()
    expect(await run(again, [l])).toMatchObject({ applied: 1 })
    expect(again.uploads.map(u => u.name)).toEqual(['front.png'])
    expect(again.commits[0].body.files[0].driveFileId).toBe('D-front.png')
  })

  it('a known id refused with wrong_folder and no local path fails the next run with a clear message', async () => {
    const l = line({ files: [{ kind: 'PRINT', printArea: 'Front', fileName: 'front.png', mimeType: 'image/png', size: 777, knownDriveFileId: 'KNOWN1' }] })
    await run(fakes({ commit: () => ({ ok: false, status: 400, body: { ok: false, code: 'wrong_folder', error: 'x' } }) }), [l])
    const again = fakes()
    const r = await run(again, [l])
    expect(r.failed).toBe(1)
    expect(again.uploads).toHaveLength(0)
    expect(again.commits).toHaveLength(0)
    expect(r.results[0].body.error).toMatch(/KNOWN1.*không có bản local/)
  })

  it('says so when a refusal also drops a known id the server did not name', async () => {
    const l = line({ files: [
      { kind: 'PRINT', printArea: 'Front', fileName: 'front.png', mimeType: 'image/png', size: 7, knownDriveFileId: 'KNOWN1' },
      { kind: 'PRINT', printArea: 'Back', fileName: 'back.png', mimeType: 'image/png', size: 7, knownDriveFileId: 'KNOWN2' },
    ] })
    const logs: string[] = []
    await run(fakes({ commit: () => ({ ok: false, status: 400, body: { ok: false, code: 'wrong_folder', error: 'File KNOWN1 không nằm trong thư mục chờ' } }) }), [l], { log: (m: string) => logs.push(m) })
    const msg = logs.find(m => m.includes('wrong_folder')) ?? ''
    expect(msg).toMatch(/KNOWN2/)
    expect(msg).toMatch(/chưa kiểm/)
    expect(entry().refusedKnown.sort()).toEqual(['KNOWN1', 'KNOWN2'])
  })

  it('never sends a DELETE or a trashed body when run with the real uploader', async () => {
    const requests: { method: string; url: string; body: any }[] = []
    const fetchImpl: any = async (url: any, init: any = {}) => {
      requests.push({ method: init.method ?? 'GET', url: String(url), body: typeof init.body === 'string' ? init.body : null })
      if (String(url).includes('uploadType=resumable')) return new Response('', { status: 200, headers: { location: 'https://www.googleapis.com/upload/s1' } })
      return new Response(JSON.stringify({ id: `F${requests.length}` }), { status: 200 })
    }
    const uploader = createUploader({ accessToken: async () => 't', fetchImpl })
    const f = fakes()
    const r = await runApiDelivery({ lines: [line()], client: f.client, uploader, ledgerPath, log: () => {} })
    expect(r.applied).toBe(1)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.some(x => x.method === 'DELETE')).toBe(false)
    expect(requests.some(x => /trashed/.test(x.body ?? ''))).toBe(false)
    expect(requests.every(x => /^https:\/\/www\.googleapis\.com\//.test(x.url))).toBe(true)
  })
})
