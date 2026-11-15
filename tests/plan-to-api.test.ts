import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { planLinesToApi, sharedIdsFromLedger, deliverPlanViaApi, NO_LOCAL_COPY } from '../scripts/lib/plan-to-api.mjs'

let dir: string
let storageRoot: string
let ledgerPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-api-'))
  storageRoot = path.join(dir, 'storage')
  fs.mkdirSync(path.join(storageRoot, 'design', 'o1'), { recursive: true })
  ledgerPath = path.join(dir, 'out', 'api-ledger.json')
})

const file = (extra: any = {}) => ({
  localId: 'cloc1', printArea: 'Front', kind: 'PRINT', version: 2, prodVersion: 1, fileName: 'front-v2.png', driveName: 'Front.png',
  mimeType: 'image/png', size: 1234, widthPx: 4200, heightPx: 4800, createdAt: '2026-11-15T01:00:00.000+00:00',
  storage: 'LOCAL', storagePath: 'design/o1/front-v2.png', driveFileId: null, driveWebViewLink: null, localPreviewPath: null, transfer: 'upload',
  ...extra,
})
const planLine = (extra: any = {}) => ({
  taskKey: 'LIT6001_1', orderId: 'o1', shopifyLineId: 'l1', orderNumber: '#6001', linePosition: 1, productTitle: 'Hoodie', localStatus: 'REVIEW',
  localFolderId: null, folderPath: ['Litzzy', '2026-11', '#6001', 'LIT6001_1'], prodTaskId: 't1', prodStatus: 'NEW', folderId: 'F1', folderUrl: null,
  folderCreated: false, action: 'push', skipReason: null, files: [file()],
  ...extra,
})

describe('planLinesToApi', () => {
  it('turns a push line into an API line with absolute local paths', () => {
    const { lines, skipped } = planLinesToApi({ lines: [planLine()] }, { storageRoot })
    expect(skipped).toEqual([])
    expect(lines).toEqual([{
      taskKey: 'LIT6001_1', action: 'push', retire: [], expectedStatus: 'NEW',
      files: [{ kind: 'PRINT', printArea: 'Front', path: path.join(storageRoot, 'design/o1/front-v2.png'), fileName: 'front-v2.png', mimeType: 'image/png', widthPx: 4200, heightPx: 4800 }],
    }])
  })

  it('carries the plan status as expectedStatus; an explicit expectedStatus wins; replace ids go in planIds', () => {
    const { lines } = planLinesToApi({ lines: [
      planLine({ taskKey: 'A', action: 'replace', prodStatus: 'REVIEW', replaces: [{ id: 'r2' }, { id: 'r1' }] }),
      planLine({ taskKey: 'B', action: 'replace', prodStatus: 'DOING', expectedStatus: ['DOING', 'REVIEW'], replaces: [{ id: 'r3' }] }),
      planLine({ taskKey: 'C', prodStatus: null }),
    ] }, { storageRoot })
    expect(lines[0]).toMatchObject({ expectedStatus: 'REVIEW', planIds: ['r2', 'r1'], retire: ['r2', 'r1'] })
    expect(lines[1].expectedStatus).toEqual(['DOING', 'REVIEW'])
    expect(lines[2].expectedStatus).toBeUndefined()
    expect(lines[2].planIds).toBeUndefined()
  })

  it('a Drive file several lines reuse goes as the first line\'s known id, later lines wait and then shortcut to it', () => {
    const reuse = (extra: any = {}) => file({ storage: 'DRIVE', driveFileId: 'SHARED1', transfer: 'reuse', ...extra })
    const plan = { lines: [planLine({ taskKey: 'A', files: [reuse()] }), planLine({ taskKey: 'B', files: [reuse({ localId: 'c2', printArea: 'Print' })] })] }
    const before = planLinesToApi(plan, { storageRoot })
    expect(before.lines.map((l: any) => l.taskKey)).toEqual(['A'])
    expect(before.lines[0].files[0]).toMatchObject({ knownDriveFileId: 'SHARED1' })
    expect(before.skipped).toEqual([{ taskKey: 'B', reason: expect.stringMatching(/SHARED1.*A/), waitingFor: 'A' }])
    const after = planLinesToApi(plan, { storageRoot, sharedIds: (task: string, part: string) => (task === 'A' && part === 'PRINT/Front' ? 'SHARED1' : null) })
    expect(after.lines.map((l: any) => l.taskKey)).toEqual(['A', 'B'])
    expect(after.lines[1].files[0]).toMatchObject({ printArea: 'Print', shortcutOf: 'SHARED1', size: 1234 })
    expect(after.lines[1].files[0].knownDriveFileId).toBeUndefined()
  })

  it('a later user of a shared Drive file waits for the first line that is actually sent', () => {
    const reuse = (extra: any = {}) => file({ storage: 'DRIVE', driveFileId: 'SHARED1', transfer: 'reuse', ...extra })
    const { lines } = planLinesToApi({ lines: [
      planLine({ taskKey: 'A', files: [reuse(), file({ printArea: 'Back', storagePath: null })] }),
      planLine({ taskKey: 'B', files: [reuse({ localId: 'c2' })] }),
    ] }, { storageRoot })
    expect(lines.map((l: any) => l.taskKey)).toEqual(['B'])
    expect(lines[0].files[0]).toMatchObject({ knownDriveFileId: 'SHARED1' })
  })

  it('defaults kind to PRINT and keeps MOCKUP', () => {
    const { lines } = planLinesToApi({ lines: [planLine({ files: [file({ kind: undefined }), file({ kind: 'MOCKUP', printArea: 'Mockup' })] })] }, { storageRoot })
    expect(lines[0].files.map((f: any) => f.kind)).toEqual(['PRINT', 'MOCKUP'])
  })

  it('skips lines whose action is not push, replace or revert, with their reason', () => {
    const { lines, skipped } = planLinesToApi({ lines: [
      planLine({ taskKey: 'A', action: 'skip', skipReason: 'Task trên prod đang DONE' }),
      planLine({ taskKey: 'B', action: 'drop', skipReason: null }),
      planLine({ taskKey: 'C' }),
    ] }, { storageRoot })
    expect(lines.map((l: any) => l.taskKey)).toEqual(['C'])
    expect(skipped).toEqual([{ taskKey: 'A', reason: 'Task trên prod đang DONE' }, { taskKey: 'B', reason: 'action drop' }])
  })

  it('leaves out kept files and retires the replaced prints', () => {
    const { lines } = planLinesToApi({ lines: [planLine({
      action: 'replace',
      files: [file({ printArea: 'Back', keep: true, localId: 'old' }), file({ keep: false })],
      replaces: [{ id: 'art-front-1', printArea: 'Front', version: 1, driveFileId: 'DF1', sharedWith: 0 }],
    })] }, { storageRoot })
    expect(lines[0]).toMatchObject({ action: 'replace', retire: ['art-front-1'] })
    expect(lines[0].files.map((f: any) => f.printArea)).toEqual(['Front'])
  })

  it('a reuse file the local push already put on Drive goes with its known id, plus its local path when there is one', () => {
    const { lines, skipped } = planLinesToApi({ lines: [planLine({ files: [
      file({ storage: 'DRIVE', driveFileId: 'DF', transfer: 'reuse' }),
      file({ printArea: 'Back', storagePath: null, storage: 'DRIVE', driveFileId: 'DX', transfer: 'reuse', size: 999 }),
    ] })] }, { storageRoot })
    expect(skipped).toEqual([])
    expect(lines[0].files).toEqual([
      { kind: 'PRINT', printArea: 'Front', path: path.join(storageRoot, 'design/o1/front-v2.png'), fileName: 'front-v2.png', mimeType: 'image/png', widthPx: 4200, heightPx: 4800, knownDriveFileId: 'DF', size: 1234 },
      { kind: 'PRINT', printArea: 'Back', fileName: 'front-v2.png', mimeType: 'image/png', widthPx: 4200, heightPx: 4800, knownDriveFileId: 'DX', size: 999 },
    ])
  })

  it('a file with neither a local copy nor a Drive id skips the line', () => {
    const { lines, skipped } = planLinesToApi({ lines: [planLine({ files: [file(), file({ printArea: 'Back', storagePath: null })] })] }, { storageRoot })
    expect(lines).toEqual([])
    expect(skipped).toEqual([{ taskKey: 'LIT6001_1', reason: NO_LOCAL_COPY }])
    expect(NO_LOCAL_COPY).toBe('không có bản local để upload')
  })

  it('a revert sends no files and no retire (the server retires every AUTO print), with readiness and reason', () => {
    const revert = { taskKey: 'LIT6002_1', action: 'revert', skipReason: null, files: [], replaces: [{ id: 'a1', printArea: 'Front', version: 1, driveFileId: 'D1' }],
      prodTaskId: 't2', prodStatus: 'REVIEW', productTitle: 'Tee', readiness: 'LOW', reason: 'designer làm tay', folderCreated: false }
    const { lines } = planLinesToApi({ lines: [revert] }, { storageRoot })
    expect(lines).toEqual([{ taskKey: 'LIT6002_1', action: 'revert', files: [], retire: [], revertReadiness: 'LOW', eventMessage: 'designer làm tay', expectedStatus: 'REVIEW', planIds: ['a1'] }])
  })

  it('passes eventMessage, retireSources and allowFinished through when set', () => {
    const { lines } = planLinesToApi({ lines: [planLine({ action: 'replace', replaces: [{ id: 'r1' }], eventMessage: 'Dùng chung file in đơn cũ LIT4997_1 (khách không custom) · front', retireSources: ['AUTO', 'MANUAL'], allowFinished: true })] }, { storageRoot })
    expect(lines[0]).toMatchObject({ eventMessage: 'Dùng chung file in đơn cũ LIT4997_1 (khách không custom) · front', retireSources: ['AUTO', 'MANUAL'], allowFinished: true })
  })

  it('a replace that only takes prints off becomes a retire', () => {
    const { lines } = planLinesToApi({ lines: [planLine({ action: 'replace', files: [], replaces: [{ id: 'r1' }, { id: 'r2' }] })] }, { storageRoot })
    expect(lines[0]).toMatchObject({ action: 'retire', files: [], retire: ['r1', 'r2'] })
  })

  describe('push-shared-prints groups', () => {
    const shared = (extra: any = {}) => file({ localId: 'cs1', printArea: 'front', version: 1, fileName: 'front.jpg', driveName: 'front.jpg', mimeType: 'image/jpeg', size: 5555, widthPx: 4500, heightPx: 5400, storage: 'DRIVE', ...extra })

    it('a MOCKUP is never a shortcut: it is uploaded per line from its path', () => {
      const mock = (extra: any) => shared({ kind: 'MOCKUP', printArea: 'Mockup', ...extra })
      const { lines } = planLinesToApi({ lines: [
        planLine({ taskKey: 'M1', files: [mock({ storagePath: 'dl/m.jpg', driveFileId: 'OLDM', transfer: 'reuse', shared: true })] }),
        planLine({ taskKey: 'M2', files: [mock({ storagePath: 'dl/m.jpg', driveFileId: null, transfer: 'reuse', shared: true, sharedFrom: 'M1' })] }),
      ] }, { storageRoot: dir })
      expect(lines.map((l: any) => l.taskKey)).toEqual(['M1', 'M2'])
      for (const l of lines) {
        expect(l.files[0]).toMatchObject({ kind: 'MOCKUP', path: path.join(dir, 'dl/m.jpg') })
        expect(l.files[0].shortcutOf).toBeUndefined()
      }
    })

    it('a shared MOCKUP without a local copy skips the line with a clear reason', () => {
      const { lines, skipped } = planLinesToApi({ lines: [planLine({ taskKey: 'M1', files: [shared({ kind: 'MOCKUP', printArea: 'Mockup', storagePath: null, driveFileId: 'OLDM', transfer: 'reuse', shared: true })] })] }, { storageRoot: dir })
      expect(lines).toEqual([])
      expect(skipped[0].reason).toMatch(/mockup.*lối tắt/i)
    })

    it('a file of an old order (driveFileId) is a shortcut with its size, never an upload', () => {
      const { lines } = planLinesToApi({ lines: [planLine({ taskKey: 'LIT5614_1', files: [shared({ storagePath: null, driveFileId: 'OLD1', transfer: 'reuse', shared: true, sharedFrom: null })] })] }, { storageRoot })
      expect(lines[0].files).toEqual([{ kind: 'PRINT', printArea: 'front', fileName: 'front.jpg', mimeType: 'image/jpeg', widthPx: 4500, heightPx: 5400, shortcutOf: 'OLD1', size: 5555 }])
    })

    it('the first line uploads the group file; a later line waits for its id, then shortcuts to it', () => {
      const first = planLine({ taskKey: 'G1', files: [shared({ storagePath: 'dl/x.jpg', driveFileId: null, transfer: 'upload', shared: false, sharedFrom: null })] })
      const later = planLine({ taskKey: 'G2', files: [shared({ localId: 'cs2', storagePath: 'dl/x.jpg', driveFileId: null, transfer: 'reuse', shared: true, sharedFrom: 'G1' })] })
      const before = planLinesToApi({ lines: [first, later] }, { storageRoot: dir })
      expect(before.lines.map((l: any) => l.taskKey)).toEqual(['G1'])
      expect(before.lines[0].files[0]).toMatchObject({ path: path.join(dir, 'dl/x.jpg') })
      expect(before.lines[0].files[0].shortcutOf).toBeUndefined()
      expect(before.skipped).toEqual([{ taskKey: 'G2', reason: expect.stringMatching(/G1/), waitingFor: 'G1' }])
      const after = planLinesToApi({ lines: [later] }, { storageRoot: dir, sharedIds: (task: string, part: string) => (task === 'G1' && part === 'PRINT/front' ? 'UP1' : null) })
      expect(after.lines[0].files[0]).toMatchObject({ shortcutOf: 'UP1', size: 5555 })
      expect(after.lines[0].files[0].path).toBeUndefined()
    })
  })
})

describe('sharedIdsFromLedger', () => {
  it('finds the uploaded id of an applied delivery of the source line, newest first', () => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
    fs.writeFileSync(ledgerPath, JSON.stringify({ lines: {
      'G1#a': { taskKey: 'G1', applied: '2026-11-15T01:00:00Z', files: { 'PRINT/front': { driveFileId: 'OLDER' } } },
      'G1#b': { taskKey: 'G1', applied: '2026-11-15T02:00:00Z', files: { 'PRINT/front': { driveFileId: 'NEWER' } } },
      'G1#c': { taskKey: 'G1', files: { 'PRINT/front': { driveFileId: 'NOT-APPLIED' } } },
    } }))
    const get = sharedIdsFromLedger(ledgerPath)
    expect(get('G1', 'PRINT/front')).toBe('NEWER')
    expect(get('G1', 'PRINT/back')).toBeNull()
    expect(get('G9', 'PRINT/front')).toBeNull()
  })

  it('an absent ledger knows nothing', () => {
    expect(sharedIdsFromLedger(ledgerPath)('G1', 'PRINT/front')).toBeNull()
  })
})

describe('deliverPlanViaApi', () => {
  const realFile = (rel: string) => {
    const p = path.join(storageRoot, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, Buffer.alloc(20, 1))
    return rel
  }
  function fakes(commit?: (key: string, body: any) => any) {
    const calls: string[] = []
    const client: any = {
      taskState: async (key: string) => { calls.push(`state ${key}`); return { ok: true, status: 200, body: { status: 'NEW', incomingFolder: { id: 'INC' }, artworks: [] } } },
      commit: async (key: string, body: any) => {
        calls.push(`commit ${key}${body.dryRun ? ' dry' : ''}`)
        if (commit) return commit(key, body)
        return { ok: true, status: 200, body: { ok: true, status: 'REVIEW', artworks: body.files.map((f: any, i: number) => ({ id: `n${i}`, kind: f.kind, printArea: f.printArea, driveFileId: f.driveFileId })), alreadyApplied: false } }
      },
      putPreview: async () => ({ ok: true, status: 200, body: {} }),
    }
    const uploader = { upload: async (a: any) => { calls.push(`upload ${a.name}`); return { id: `D-${a.name}`, size: fs.statSync(a.path).size } } }
    let made = 0
    const makeDeps = () => { made++; return { client, uploader } }
    return { calls, makeDeps, made: () => made }
  }
  const go = (plan: any, f: ReturnType<typeof fakes>, extra: any = {}) => {
    const logs: string[] = []
    return deliverPlanViaApi({ plan, storageRoot, ledgerPath, makeDeps: f.makeDeps, log: (m: string) => logs.push(m), ...extra }).then((r: any) => ({ ...r, logs }))
  }

  it('with no line to send it never builds the client and exits 0', async () => {
    const f = fakes()
    const r = await go({ lines: [planLine({ action: 'skip', skipReason: 'Prod không có task này' })] }, f)
    expect(f.made()).toBe(0)
    expect(r.exitCode).toBe(0)
    expect(r.logs.join('\n')).toMatch(/0 dòng/)
    expect(r.logs.join('\n')).toMatch(/Prod không có task này/)
  })

  it('delivers, prints one summary line per line, exits 0 when only prod refused a line', async () => {
    const rel = realFile('design/o1/a.png')
    const f = fakes(key => key === 'NO' ? { ok: false, status: 409, body: { error: 'đã đổi', code: 'stale_state' } } : { ok: true, status: 200, body: { ok: true, status: 'REVIEW', artworks: [], alreadyApplied: false } })
    const r = await go({ lines: [planLine({ taskKey: 'OK', files: [file({ storagePath: rel })] }), planLine({ taskKey: 'NO', files: [file({ storagePath: rel })] })] }, f)
    expect(r.exitCode).toBe(0)
    const text = r.logs.join('\n')
    expect(text).toMatch(/OK .*đã ghi/)
    expect(text).toMatch(/NO .*409.*stale_state/)
  })

  it('a task that moved since the snapshot is reported stale and does not fail the run', async () => {
    const rel = realFile('design/o1/a.png')
    const f = fakes()
    const deps = f.makeDeps()
    deps.client.taskState = async () => ({ ok: true, status: 200, body: { status: 'DOING', incomingFolder: { id: 'INC' }, artworks: [] } })
    const r = await go({ lines: [planLine({ files: [file({ storagePath: rel })] })] }, f)
    expect(r.exitCode).toBe(0)
    expect(f.calls.filter(c => c.startsWith('upload') || c.startsWith('commit'))).toEqual([])
    expect(r.logs.join('\n')).toMatch(/LIT6001_1 .*stale.*DOING/)
  })

  it('a 400 answer fails the run (exit 1)', async () => {
    const rel = realFile('design/o1/a.png')
    const f = fakes(() => ({ ok: false, status: 400, body: { error: 'khổ cũ', code: 'old_layout' } }))
    const r = await go({ lines: [planLine({ files: [file({ storagePath: rel })] })] }, f)
    expect(r.exitCode).toBe(1)
    expect(r.logs.join('\n')).toMatch(/LIT6001_1 .*400.*old_layout/)
  })

  it('push-local-renders lines sharing one Drive file: the first commits it, the later one shortcuts to it in the same run', async () => {
    const rel = realFile('design/o1/a.png')
    const f = fakes()
    const commits: any[] = []
    const base = f.makeDeps().client.commit
    f.makeDeps().client.commit = async (key: string, body: any) => { commits.push({ key, body }); return base(key, body) }
    const reuse = (extra: any = {}) => file({ storage: 'DRIVE', driveFileId: 'SHARED1', transfer: 'reuse', storagePath: rel, size: 20, ...extra })
    const r = await go({ lines: [planLine({ taskKey: 'A', files: [reuse()] }), planLine({ taskKey: 'B', files: [reuse({ localId: 'c2' })] })] }, f)
    expect(r.exitCode).toBe(0)
    expect(f.calls.filter(c => c.startsWith('upload'))).toEqual([])
    expect(commits.map(c => c.key)).toEqual(['A', 'B'])
    expect(commits[0].body.files[0]).toMatchObject({ driveFileId: 'SHARED1' })
    expect(commits[0].body.files[0].shortcutOf).toBeUndefined()
    expect(commits[1].body.files[0]).toMatchObject({ driveFileId: 'SHARED1', shortcutOf: 'SHARED1' })
  })

  it('exits 1 when a line failed', async () => {
    const f = fakes()
    const r = await go({ lines: [planLine({ files: [file({ storagePath: 'design/o1/missing.png' })] })] }, f)
    expect(r.exitCode).toBe(1)
    expect(r.logs.join('\n')).toMatch(/LIT6001_1 .*lỗi/)
  })

  it('a dry run sends dryRun commits and says nothing was written', async () => {
    const rel = realFile('design/o1/a.png')
    const f = fakes()
    const r = await go({ lines: [planLine({ files: [file({ storagePath: rel })] })] }, f, { dryRun: true })
    expect(f.calls).toContain('commit LIT6001_1 dry')
    expect(r.exitCode).toBe(0)
    expect(r.logs.join('\n')).toMatch(/dry run/i)
  })

  it('a stop from the server ends the run with exit 1 and its message, without throwing', async () => {
    const { DeliveryStopped } = await import('../scripts/lib/delivery-client.mjs')
    const rel = realFile('design/o1/a.png')
    const f = fakes()
    const deps = f.makeDeps()
    deps.client.taskState = async () => { throw new DeliveryStopped('server báo disabled', { status: 503, code: 'disabled' }) }
    const r = await go({ lines: [planLine({ files: [file({ storagePath: rel })] })] }, f)
    expect(r.exitCode).toBe(1)
    expect(r.logs.join('\n')).toMatch(/DỪNG.*disabled/)
  })

  it('a missing env stops before anything is sent', async () => {
    const rel = realFile('design/o1/a.png')
    const r = await deliverPlanViaApi({ plan: { lines: [planLine({ files: [file({ storagePath: rel })] })] }, storageRoot, ledgerPath, log: () => {},
      makeDeps: () => { throw new Error('ECOM_URL chưa được đặt') } }).catch((e: any) => e)
    expect(r).toBeInstanceOf(Error)
    expect(String(r.message)).toMatch(/ECOM_URL/)
  })

  it('a shared group: the later line shortcuts to the id the first line uploaded in the same run', async () => {
    const rel = realFile('dl/x.jpg')
    const sharedFile = (extra: any) => file({ printArea: 'front', fileName: 'front.jpg', mimeType: 'image/jpeg', size: 20, storagePath: rel, ...extra })
    const f = fakes()
    const commits: any[] = []
    const base = f.makeDeps().client.commit
    f.makeDeps().client.commit = async (key: string, body: any) => { commits.push({ key, body }); return base(key, body) }
    const r = await go({ lines: [
      planLine({ taskKey: 'G1', files: [sharedFile({ transfer: 'upload', shared: false, sharedFrom: null })] }),
      planLine({ taskKey: 'G2', files: [sharedFile({ localId: 'c2', transfer: 'reuse', shared: true, sharedFrom: 'G1' })] }),
    ] }, f)
    expect(r.exitCode).toBe(0)
    expect(f.calls.filter(c => c.startsWith('upload'))).toHaveLength(1)
    expect(commits.map(c => c.key)).toEqual(['G1', 'G2'])
    expect(commits[1].body.files[0]).toMatchObject({ shortcutOf: 'D-front.jpg', driveFileId: 'D-front.jpg' })
  })

  it('in a dry run the later line of a shared group stays waiting (the first line is not applied)', async () => {
    const rel = realFile('dl/x.jpg')
    const sharedFile = (extra: any) => file({ printArea: 'front', fileName: 'front.jpg', mimeType: 'image/jpeg', size: 20, storagePath: rel, ...extra })
    const f = fakes()
    const r = await go({ lines: [
      planLine({ taskKey: 'G1', files: [sharedFile({ transfer: 'upload', shared: false, sharedFrom: null })] }),
      planLine({ taskKey: 'G2', files: [sharedFile({ localId: 'c2', transfer: 'reuse', shared: true, sharedFrom: 'G1' })] }),
    ] }, f, { dryRun: true })
    expect(r.exitCode).toBe(0)
    expect(f.calls.filter(c => c.startsWith('commit'))).toEqual(['commit G1 dry'])
    expect(r.logs.join('\n')).toMatch(/G2 .*G1/)
  })
})
