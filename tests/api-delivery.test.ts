import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runApiDelivery } from '../scripts/lib/api-delivery.mjs'
import { DeliveryGaveUp } from '../scripts/lib/delivery-client.mjs'

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
        body: { ok: true, status: 'REVIEW', artworks: body.files.map((f: any, i: number) => ({ id: `n${i}`, kind: f.kind, printArea: f.printArea })), alreadyApplied: false },
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
    expect(ledger().lines.LIT1_1.applied).toBeTruthy()
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
    const led = ledger().lines.LIT1_1
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
    expect(Object.keys(snapshot.lines.LIT1_1.files)).toHaveLength(2)
    expect(snapshot.lines.LIT1_1.applied).toBeFalsy()
    expect(fs.existsSync(`${ledgerPath}.tmp`)).toBe(false)
  })

  it('re-uploads a file whose local copy changed since the ledger entry, leaving the old one on Drive', async () => {
    const crashing = fakes({ commit: () => { throw new DeliveryGaveUp('down', { status: 503 }) } })
    const l = line()
    await expect(run(crashing, [l])).rejects.toBeInstanceOf(DeliveryGaveUp)
    fs.writeFileSync(l.files[0].path, Buffer.alloc(55, 9))
    const second = fakes()
    await run(second, [l])
    expect(second.uploads.map(u => u.name)).toEqual(['front.png'])
  })

  it('on a 409 re-reads state, records skippedOnProd, and never deletes on Drive', async () => {
    const f = fakes({ commit: () => ({ ok: false, status: 409, body: { error: 'đã đổi', code: 'stale_state' } }) })
    const r = await run(f, [line()])
    expect(r).toMatchObject({ applied: 0, skipped: 1 })
    expect(f.events.filter(e => e === 'state LIT1_1')).toHaveLength(2)
    expect(ledger().lines.LIT1_1.skippedOnProd).toEqual({ code: 'stale_state', error: 'đã đổi', status: 409 })
    expect(ledger().lines.LIT1_1.applied).toBeFalsy()
    expect(Object.keys(f.uploader)).toEqual(['upload'])
  })

  it('records 400 and 404 as skippedOnProd too', async () => {
    for (const status of [400, 404]) {
      fs.rmSync(ledgerPath, { force: true })
      const f = fakes({ commit: () => ({ ok: false, status, body: { error: 'nope', code: 'bad' } }) })
      const r = await run(f, [line()])
      expect(r.skipped).toBe(1)
      expect(ledger().lines.LIT1_1.skippedOnProd.status).toBe(status)
    }
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
  })
})
