import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { createClient } from '@libsql/client'
import { openQueue } from '../scripts/review-queue/store.mjs'

const H3 = 10_800_000
let root: string
let clock: number
let q: any
const now = () => new Date(clock)
const file = (part: string, sha: string) => ({ part, kind: 'PRINT', path: `C:/x/${part}.png`, sha256: sha })
const pass = { verdict: 'pass', items: [] as string[] }
const base = (over: any = {}) => ({
  taskKey: 'LIT1_1',
  groupKey: 'LIT1_1',
  kind: 'line',
  apiLines: [{ taskKey: 'LIT1_1' }],
  files: [file('front', 'aaa')],
  meta: { custom: 'Anna' },
  qa: pass,
  ...over,
})

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-store-'))
  clock = Date.parse('2026-11-15T10:00:00Z')
  q = await openQueue({ root, now })
})
afterEach(async () => {
  await q.close()
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
})

describe('addOrUpdate', () => {
  it('creates a waiting item with version 1', async () => {
    const r = await q.addOrUpdate(base())
    expect(r).toMatchObject({ version: 1, created: true, changed: true })
    expect(r.itemId).toMatch(/^rq_/)
    const it = await q.get(r.itemId)
    expect(it).toMatchObject({ status: 'waiting', version: 1, taskKey: 'LIT1_1', groupKey: 'LIT1_1', kind: 'line' })
    expect(it.enteredAt).toBe('2026-11-15T10:00:00.000Z')
    expect(it.apiLines).toEqual([{ taskKey: 'LIT1_1' }])
    expect(it.meta).toEqual({ custom: 'Anna' })
    expect(it.qa).toEqual(pass)
    expect(await q.versions(r.itemId)).toHaveLength(1)
  })

  it('same sha256 set changes nothing, whatever the order', async () => {
    const a = await q.addOrUpdate(base({ files: [file('front', 'a'), file('back', 'b')] }))
    clock += 60_000
    const b = await q.addOrUpdate(base({ files: [file('back', 'b'), file('front', 'a')], meta: { custom: 'Other' } }))
    expect(b).toEqual({ itemId: a.itemId, version: 1, created: false, changed: false })
    const it = await q.get(a.itemId)
    expect(it.enteredAt).toBe('2026-11-15T10:00:00.000Z')
    expect(it.meta).toEqual({ custom: 'Anna' })
    expect(await q.versions(a.itemId)).toHaveLength(1)
  })

  it('refresh records a new version with the same files and moves the item back to waiting (qa_failed per qa)', async () => {
    const a = await q.addOrUpdate(base())
    await q.setStatus(a.itemId, 'needs_look', { reason: 'prod đổi' })
    clock += 3_600_000
    const lines = [{ taskKey: 'LIT1_1', action: 'replace', planIds: ['p1'] }]
    const b = await q.addOrUpdate(base({ apiLines: lines, refresh: true }))
    expect(b).toEqual({ itemId: a.itemId, version: 2, created: false, changed: true })
    const it = await q.get(a.itemId)
    expect(it).toMatchObject({ status: 'waiting', statusReason: null, version: 2, apiLines: lines, enteredAt: '2026-11-15T11:00:00.000Z' })
    expect((await q.versions(a.itemId))[1].apiLines).toEqual(lines)
    const c = await q.addOrUpdate(base({ apiLines: lines, refresh: true, qa: { verdict: 'fail', items: ['x'] } }))
    expect(c.version).toBe(3)
    expect((await q.get(a.itemId)).status).toBe('qa_failed')
    expect(await q.addOrUpdate(base({ apiLines: lines }))).toMatchObject({ version: 3, changed: false })
  })

  it('a new sha creates v2 and resets the clock', async () => {
    const a = await q.addOrUpdate(base())
    clock += 3_600_000
    const b = await q.addOrUpdate(base({ files: [file('front', 'zzz')] }))
    expect(b).toEqual({ itemId: a.itemId, version: 2, created: false, changed: true })
    const it = await q.get(a.itemId)
    expect(it.version).toBe(2)
    expect(it.enteredAt).toBe('2026-11-15T11:00:00.000Z')
    const vs = await q.versions(a.itemId)
    expect(vs.map((v: any) => v.n)).toEqual([1, 2])
    expect(vs[1].files[0].sha256).toBe('zzz')
  })

  it('a rejected item with a new version goes back to waiting', async () => {
    const a = await q.addOrUpdate(base())
    await q.setStatus(a.itemId, 'rejected', { reason: 'tên lệch' })
    expect((await q.get(a.itemId)).statusReason).toBe('tên lệch')
    await q.addOrUpdate(base({ files: [file('front', 'new')] }))
    const it = await q.get(a.itemId)
    expect(it.status).toBe('waiting')
    expect(it.statusReason).toBeNull()
  })

  it('a failed qa makes it qa_failed, and a passing new version clears it', async () => {
    const a = await q.addOrUpdate(base({ qa: { verdict: 'fail', items: ['name overflows'] } }))
    expect((await q.get(a.itemId)).status).toBe('qa_failed')
    await q.addOrUpdate(base({ files: [file('front', 'fixed')] }))
    expect((await q.get(a.itemId)).status).toBe('waiting')
  })

  it('a new version on a fixing item is recorded but the status stays fixing (the fix job decides)', async () => {
    const a = await q.addOrUpdate(base())
    await q.setStatus(a.itemId, 'fixing')
    const it0 = await q.get(a.itemId)
    expect(it0.prevStatus).toBe('waiting')
    const r = await q.addOrUpdate(base({ files: [file('front', 'out')] }))
    expect(r).toMatchObject({ version: 2, changed: true, created: false })
    const it = await q.get(a.itemId)
    expect(it.status).toBe('fixing')
    expect(it.version).toBe(2)
  })

  it('a delivered item is not active: the same groupKey makes a new item', async () => {
    const a = await q.addOrUpdate(base())
    await q.setStatus(a.itemId, 'approved')
    const b = await q.addOrUpdate(base())
    expect(b.created).toBe(true)
    expect(b.itemId).not.toBe(a.itemId)
    expect((await q.activeByTaskKey('LIT1_1'))?.id).toBe(b.itemId)
  })

  it('a new item takes the id the caller picked (files are copied under it first); an existing one keeps its own', async () => {
    const a = await q.addOrUpdate(base({ id: 'rq_picked01' }))
    expect(a).toMatchObject({ itemId: 'rq_picked01', created: true })
    const b = await q.addOrUpdate(base({ id: 'rq_other02', files: [file('front', 'zzz')] }))
    expect(b).toMatchObject({ itemId: 'rq_picked01', version: 2, created: false })
    await expect(q.addOrUpdate(base({ id: 'bad id/..', groupKey: 'G9', taskKey: 'K9' }))).rejects.toThrow(/id/)
  })

  it('member keys: activeByTaskKey finds a group item by any member; a changed member set is a new version even with the same files', async () => {
    const a = await q.addOrUpdate(base({ taskKey: 'A_1', groupKey: 'A_1' }))
    expect(await q.memberKeys(a.itemId)).toEqual(['A_1'])
    expect(await q.activeByTaskKey('B_1')).toBeNull()
    clock += 60_000
    const b = await q.addOrUpdate(base({ taskKey: 'A_1', groupKey: 'A_1', kind: 'group', taskKeys: ['A_1', 'B_1'] }))
    expect(b).toMatchObject({ itemId: a.itemId, version: 2, changed: true })
    const it = await q.get(a.itemId)
    expect(it.kind).toBe('group')
    expect(it.enteredAt).toBe('2026-11-15T10:01:00.000Z')
    expect(await q.memberKeys(a.itemId)).toEqual(['A_1', 'B_1'])
    expect((await q.activeByTaskKey('B_1'))?.id).toBe(a.itemId)
    const c = await q.addOrUpdate(base({ taskKey: 'A_1', groupKey: 'A_1', kind: 'group', taskKeys: ['B_1', 'A_1'] }))
    expect(c.changed).toBe(false)
    await q.setStatus(a.itemId, 'approved')
    expect(await q.activeByTaskKey('B_1')).toBeNull()
  })

  it('refuses (key_held) a member key another active item of a different group holds, inside the write; writes nothing', async () => {
    const a = await q.addOrUpdate(base({ taskKey: 'A_1', groupKey: 'A_1', kind: 'group', taskKeys: ['A_1', 'B_1'] }))
    const err: any = await q.addOrUpdate(base({ taskKey: 'B_1', groupKey: 'B_1' })).catch((e: any) => e)
    expect(err.code).toBe('key_held')
    expect(err.itemId).toBe(a.itemId)
    expect(err.taskKey).toBe('B_1')
    expect(await q.list({})).toHaveLength(1)
    const c = await q.addOrUpdate(base({ taskKey: 'C_1', groupKey: 'C_1', taskKeys: ['C_1', 'A_1'] })).catch((e: any) => e)
    expect(c.code).toBe('key_held')
    await q.setStatus(a.itemId, 'cloud')
    expect((await q.addOrUpdate(base({ taskKey: 'B_1', groupKey: 'B_1' }))).created).toBe(true)
  })
})

describe('in-process concurrency', () => {
  it('a lock release that fails is logged, never replaces the result of fn', async () => {
    const r = await q.addOrUpdate(base())
    const other = createClient({ url: `file:${path.join(root, 'queue.db').replace(/\\/g, '/')}` })
    const err = console.error
    const said: string[] = []
    console.error = (m: string) => { said.push(m) }
    try {
      const out = await q.withLock(r.itemId, async () => { await other.execute('DROP TABLE locks'); return 'result' })
      expect(out).toBe('result')
      expect(said.join(' ')).toMatch(/không nhả được khoá/)
    } finally {
      console.error = err
      other.close()
    }
  })

  it('two withLock calls at once in one process: one runs, the other gets code locked (never SQLITE_BUSY)', async () => {
    const r = await q.addOrUpdate(base())
    const slow = () => new Promise(res => setTimeout(() => res('done'), 50))
    const out = await Promise.allSettled([q.withLock(r.itemId, slow), q.withLock(r.itemId, slow)])
    const codes = out.map(o => (o.status === 'fulfilled' ? o.value : (o as any).reason.code)).sort()
    expect(codes).toEqual(['done', 'locked'])
    const both = await Promise.all([q.addEvent(r.itemId, 'x', 'a'), q.setStatus(r.itemId, 'rejected', { reason: 'r' }), q.addEvent(r.itemId, 'x', 'b')])
    expect(both).toHaveLength(3)
  })
})

describe('reads', () => {
  it('list filters by status, get returns null for unknown, events are kept in order', async () => {
    const a = await q.addOrUpdate(base())
    const b = await q.addOrUpdate(base({ taskKey: 'LIT2_1', groupKey: 'LIT2_1' }))
    await q.setStatus(b.itemId, 'rejected')
    expect((await q.list({ statuses: ['rejected'] })).map((i: any) => i.id)).toEqual([b.itemId])
    expect(await q.list({})).toHaveLength(2)
    expect(await q.get('nope')).toBeNull()
    await q.addEvent(a.itemId, 'note', 'one')
    await q.addEvent(a.itemId, 'note', 'two')
    const ev = await q.events(a.itemId)
    expect(ev.filter((e: any) => e.type === 'note').map((e: any) => e.message)).toEqual(['one', 'two'])
  })

  it('activeByTaskKey ignores delivered and unknown keys', async () => {
    const a = await q.addOrUpdate(base())
    expect((await q.activeByTaskKey('LIT1_1')).id).toBe(a.itemId)
    expect(await q.activeByTaskKey('X')).toBeNull()
    await q.setStatus(a.itemId, 'removed')
    expect(await q.activeByTaskKey('LIT1_1')).toBeNull()
  })
})

describe('expired', () => {
  it('only waiting and qa_failed count down, at exactly 3h', async () => {
    const w = await q.addOrUpdate(base())
    const f = await q.addOrUpdate(base({ taskKey: 'B', groupKey: 'B', qa: { verdict: 'fail', items: ['x'] } }))
    const r = await q.addOrUpdate(base({ taskKey: 'C', groupKey: 'C' }))
    const x = await q.addOrUpdate(base({ taskKey: 'D', groupKey: 'D' }))
    const n = await q.addOrUpdate(base({ taskKey: 'E', groupKey: 'E' }))
    await q.setStatus(r.itemId, 'rejected')
    await q.setStatus(x.itemId, 'fixing')
    await q.setStatus(n.itemId, 'needs_look')
    expect(await q.expired(new Date(clock + H3 - 1))).toEqual([])
    const ids = (await q.expired(new Date(clock + H3))).map((i: any) => i.id).sort()
    expect(ids).toEqual([w.itemId, f.itemId].sort())
  })

  it('counts from the current version enteredAt', async () => {
    await q.addOrUpdate(base())
    clock += 7_200_000
    await q.addOrUpdate(base({ files: [file('front', 'v2')] }))
    expect(await q.expired(new Date(clock + H3 - 1))).toEqual([])
    expect(await q.expired(new Date(clock + H3))).toHaveLength(1)
  })
})

describe('withLock', () => {
  it('runs fn, returns its value and releases', async () => {
    const a = await q.addOrUpdate(base())
    expect(await q.withLock(a.itemId, async () => 7)).toBe(7)
    expect(await q.withLock(a.itemId, async () => 8)).toBe(8)
  })

  it('releases when fn throws', async () => {
    const a = await q.addOrUpdate(base())
    await expect(q.withLock(a.itemId, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await q.withLock(a.itemId, async () => 1)).toBe(1)
  })

  it('refuses a second holder with code locked', async () => {
    const a = await q.addOrUpdate(base())
    await q.withLock(a.itemId, async () => {
      await expect(q.withLock(a.itemId, async () => 1)).rejects.toMatchObject({ code: 'locked' })
    })
  })

  it('refuses a holder from another connection on the same db', async () => {
    const a = await q.addOrUpdate(base())
    const q2 = await openQueue({ root, now })
    try {
      await q.withLock(a.itemId, async () => {
        await expect(q2.withLock(a.itemId, async () => 1)).rejects.toMatchObject({ code: 'locked' })
      })
    } finally {
      await q2.close()
    }
  })

  it('recovers a lock older than 60 minutes (a fix job may hold one that long)', async () => {
    const a = await q.addOrUpdate(base())
    let stolen = false
    await q.withLock(a.itemId, async () => {
      clock += 60 * 60_000
      await q.withLock(a.itemId, async () => { stolen = true })
    })
    expect(stolen).toBe(true)
  })

  it('does not steal a young lock of a live pid', async () => {
    const a = await q.addOrUpdate(base())
    await q.withLock(a.itemId, async () => {
      clock += 59 * 60_000
      await expect(q.withLock(a.itemId, async () => 1)).rejects.toMatchObject({ code: 'locked' })
    })
  })

  it('recovers a lock whose pid is dead', async () => {
    const dead = await openQueue({ root, now, isAlive: () => false })
    try {
      const a = await dead.addOrUpdate(base())
      let ran = false
      await dead.withLock(a.itemId, async () => {
        await dead.withLock(a.itemId, async () => { ran = true })
      })
      expect(ran).toBe(true)
    } finally {
      await dead.close()
    }
  })
})

describe('openQueue', () => {
  it('creates the root and reopens existing data', async () => {
    const nested = path.join(root, 'a', 'b')
    const q1 = await openQueue({ root: nested, now })
    const r = await q1.addOrUpdate(base())
    await q1.close()
    expect(fs.existsSync(path.join(nested, 'queue.db'))).toBe(true)
    const q2 = await openQueue({ root: nested, now })
    expect((await q2.get(r.itemId))?.taskKey).toBe('LIT1_1')
    await q2.close()
  })
})

describe('concurrency and integrity', () => {
  it('a write from a second connection waits for a writer in another process instead of failing busy', async () => {
    const q2 = await openQueue({ root, now })
    try {
      await q2.addOrUpdate(base({ taskKey: 'W0', groupKey: 'W0' }))
      const dbUrl = 'file:' + path.join(root, 'queue.db').split(path.sep).join('/')
      const script = `
        const { createClient } = require('@libsql/client');
        const c = createClient({ url: ${JSON.stringify(dbUrl)} });
        (async () => {
          await c.execute('PRAGMA busy_timeout = 5000');
          const tx = await c.transaction('write');
          await tx.execute("INSERT INTO events (itemId, type, message, createdAt) VALUES ('x','hold','hold','t')");
          console.log('ready');
          await new Promise(r => setTimeout(r, 800));
          await tx.commit();
          process.exit(0);
        })();`
      const child = spawn(process.execPath, ['-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] })
      await new Promise<void>(res => child.stdout.on('data', d => String(d).includes('ready') && res()))
      const t0 = Date.now()
      const r = await q2.addOrUpdate(base({ taskKey: 'W1', groupKey: 'W1' }))
      expect(r.created).toBe(true)
      expect(Date.now() - t0).toBeGreaterThan(300)
      await new Promise(res => child.on('exit', res))
    } finally {
      await q2.close()
    }
  })

  it('the database refuses a second active item for a group', async () => {
    const a = await q.addOrUpdate(base())
    await q.setStatus(a.itemId, 'approved')
    const b = await q.addOrUpdate(base())
    await expect(q.setStatus(a.itemId, 'waiting')).rejects.toMatchObject({ code: 'group_active' })
    expect((await q.get(a.itemId)).status).toBe('approved')
    await q.setStatus(b.itemId, 'rejected')
    expect((await q.get(b.itemId)).status).toBe('rejected')
  })

  it('the unique index backs the rule even for raw inserts', async () => {
    await q.addOrUpdate(base())
    const { createClient } = await import('@libsql/client')
    const c = createClient({ url: 'file:' + path.join(root, 'queue.db').split(path.sep).join('/') })
    await expect(
      c.execute({
        sql: `INSERT INTO items (id, taskKey, groupKey, kind, status, version, enteredAt, createdAt, updatedAt, apiLines, meta, qa)
              VALUES ('dup','LIT1_1','LIT1_1','line','waiting',1,'t','t','t','null','null','null')`,
        args: [],
      }),
    ).rejects.toThrow(/UNIQUE/)
    c.close()
  })

  it('setStatus rejects an unknown status; expired accepts Date, epoch ms and ISO string', async () => {
    const a = await q.addOrUpdate(base())
    await expect(q.setStatus(a.itemId, 'bogus')).rejects.toThrow(/không hợp lệ/)
    const at = clock + H3
    expect(await q.expired(at)).toHaveLength(1)
    expect(await q.expired(new Date(at).toISOString())).toHaveLength(1)
    expect(await q.expired(new Date(at - 1))).toHaveLength(0)
  })

  it('a lock is released by its own token, not by pid alone', async () => {
    const a = await q.addOrUpdate(base())
    const dead = await openQueue({ root, now, isAlive: () => false })
    try {
      await q.withLock(a.itemId, async () => {
        await dead.withLock(a.itemId, async () => {})
      })
      await expect(q.withLock(a.itemId, async () => 1)).resolves.toBe(1)
    } finally {
      await dead.close()
    }
  })
})
