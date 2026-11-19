import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateAgentRunnerToken, revokeAgentRunnerToken } from '@/lib/design-agent/runner'
import { readWorkBoard, replaceWorkBoard, BOARD_STALE_MS } from '@/lib/design-agent/work-board'
import { PUT } from '@/app/api/design-agent/runner/board/route'

const entry = (n: number, over: Record<string, unknown> = {}) => ({ taskKey: `WB${n}`, source: 'STREAM' as const, worker: 'A', state: 'DOING', ...over })
const put = (body: unknown, token?: string) =>
  PUT(new NextRequest('http://localhost/api/design-agent/runner/board', {
    method: 'PUT',
    headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

beforeEach(async () => {
  await prisma.workBoardEntry.deleteMany({})
  await prisma.appSetting.deleteMany({ where: { key: { in: ['design.board.publishedAt', 'design.board.rejectedOwner', 'design.agent.tokenHash'] } } })
})

afterAll(async () => {
  await revokeAgentRunnerToken()
  await prisma.workBoardEntry.deleteMany({})
})

describe('work board', () => {
  it('replaces the whole board and records the time', async () => {
    const t1 = new Date('2026-11-19T10:00:00Z')
    expect(await replaceWorkBoard({ entries: [entry(1), entry(2), entry(3)] }, t1)).toEqual({ count: 3 })
    expect(await prisma.workBoardEntry.count()).toBe(3)
    const t2 = new Date('2026-11-19T10:02:00Z')
    expect(await replaceWorkBoard({ entries: [entry(4, { source: 'LOCAL_QUEUE', etaAt: '2026-11-19T11:00:00Z', version: 2, detail: 'x' })] }, t2)).toEqual({ count: 1 })
    const board = await readWorkBoard(null, t2)
    expect(board.entries).toHaveLength(1)
    expect(board.entries[0]).toMatchObject({ taskKey: 'WB4', source: 'LOCAL_QUEUE', version: 2, detail: 'x' })
    expect(board.entries[0].etaAt?.toISOString()).toBe('2026-11-19T11:00:00.000Z')
    expect(board.publishedAt?.toISOString()).toBe(t2.toISOString())
    expect((await readWorkBoard(['WB9'], t2)).entries).toHaveLength(0)
    expect((await readWorkBoard(['WB4'], t2)).entries).toHaveLength(1)
  })

  it('reports never-published and 10-minute-old boards as not fresh', async () => {
    const never = await readWorkBoard(null)
    expect(never).toMatchObject({ fresh: false, publishedAt: null, rejectedOwner: null, entries: [] })
    const t = new Date('2026-11-19T10:00:00Z')
    await replaceWorkBoard({ entries: [entry(1)] }, t)
    expect(BOARD_STALE_MS).toBe(600_000)
    expect((await readWorkBoard(null, new Date(t.getTime() + 599_999))).fresh).toBe(true)
    expect((await readWorkBoard(null, new Date(t.getTime() + 600_001))).fresh).toBe(false)
  })

  it('keeps rejectedOwner', async () => {
    await replaceWorkBoard({ entries: [entry(1)], rejectedOwner: 'Linh' })
    expect((await readWorkBoard(null)).rejectedOwner).toBe('Linh')
    await replaceWorkBoard({ entries: [entry(1)] })
    expect((await readWorkBoard(null)).rejectedOwner).toBeNull()
  })

  it('refuses a malformed row with 400 and leaves the board unchanged', async () => {
    const token = await generateAgentRunnerToken()
    const ok = await put({ entries: [entry(1), entry(2)] }, token)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, count: 2 })
    for (const bad of [
      { entries: 'x' },
      { entries: [entry(3), { ...entry(4), taskKey: '' }] },
      { entries: [entry(3), entry(4, { source: 'OTHER' })] },
      { entries: [entry(3), entry(4, { worker: '' })] },
      { entries: [entry(3), entry(4, { state: undefined })] },
      { entries: [entry(3), entry(4, { etaAt: 'not-a-date' })] },
      { entries: [entry(3), entry(4, { version: 1.5 })] },
      { entries: [entry(3), entry(4, { detail: 7 })] },
      { entries: [entry(3), null] },
      {},
      { entries: Array.from({ length: 5001 }, (_, i) => entry(i)) },
    ]) {
      const r = await put(bad, token)
      expect(r.status).toBe(400)
      expect(typeof (await r.json()).error).toBe('string')
    }
    expect((await prisma.workBoardEntry.findMany()).map(r => r.taskKey).sort()).toEqual(['WB1', 'WB2'])
  })

  it('accepts the 5000-row limit and an empty board', async () => {
    const token = await generateAgentRunnerToken()
    const full = await put({ entries: Array.from({ length: 5000 }, (_, i) => entry(i, { detail: 'd', version: 1, etaAt: '2026-11-19T11:00:00Z' })), rejectedOwner: 'Linh' }, token)
    expect(full.status).toBe(200)
    expect(await full.json()).toEqual({ ok: true, count: 5000 })
    expect(await prisma.workBoardEntry.count()).toBe(5000)
    expect((await readWorkBoard(null)).rejectedOwner).toBe('Linh')
    const empty = await put({ entries: [] }, token)
    expect(await empty.json()).toEqual({ ok: true, count: 0 })
    const board = await readWorkBoard(null)
    expect(board).toMatchObject({ fresh: true, rejectedOwner: null, entries: [] })
  })

  it('requires the runner token', async () => {
    const token = await generateAgentRunnerToken()
    expect((await put({ entries: [entry(1)] })).status).toBe(401)
    expect((await put({ entries: [entry(1)] }, 'dag_wrong')).status).toBe(401)
    expect(await prisma.workBoardEntry.count()).toBe(0)
    expect((await put({ entries: [entry(1)] }, token)).status).toBe(200)
  })
})
