import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
import { forEachConnectedStore, safeErrorText, mergeStoreResults } from '@/lib/store-jobs'
import { SHOPIFY_PAYOUT_START_DATE, payoutStartFor } from '@/lib/shopify-payout-policy'

const A = 'sj-a.myshopify.com'
const B = 'sj-b.myshopify.com'
const C = 'sj-c.myshopify.com'
const MINE = [A, B, C]

let ids: Record<string, string> = {}
const realFetch = global.fetch

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

async function cleanup() {
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: MINE } } })
}

async function makeStore(shop: string, minutesAgo: number, token: string | null = `token-${shop}`) {
  const store = await prisma.shopifyStore.create({ data: { shop, connectedAt: new Date(Date.now() - minutesAgo * 60_000) } })
  ids[shop] = store.id
  if (token) await saveStoreCredential(store.id, { authMode: 'TOKEN', accessToken: token })
}

const onlyMine = () => ({ storeIds: MINE.map(shop => ids[shop]).filter(Boolean) })
const lastError = async (shop: string) => (await prisma.shopifyStore.findUnique({ where: { id: ids[shop] } }))!.lastError

describe('forEachConnectedStore', () => {
  beforeEach(async () => {
    ids = {}
    await cleanup()
    await makeStore(A, 30)
    await makeStore(B, 20)
  })
  afterEach(async () => {
    global.fetch = realFetch
    await cleanup()
  })

  it('runs stores one at a time, in order', async () => {
    const log: string[] = []
    const results = await forEachConnectedStore('sj-order', async (conn) => {
      log.push(`start ${conn.shop}`)
      await tick(20)
      log.push(`end ${conn.shop}`)
      return conn.shop
    }, onlyMine())
    expect(log).toEqual([`start ${A}`, `end ${A}`, `start ${B}`, `end ${B}`])
    expect(results.map(r => r.shop)).toEqual([A, B])
    expect(results.every(r => r.ok)).toBe(true)
  })

  it("gives the job that store's own connection", async () => {
    const seen: Array<{ shop: string; token: string; storeId: string }> = []
    await forEachConnectedStore('sj-conn', async (conn, store) => {
      seen.push({ shop: conn.shop, token: conn.token, storeId: store.id })
    }, onlyMine())
    expect(seen).toEqual([
      { shop: A, token: `token-${A}`, storeId: ids[A] },
      { shop: B, token: `token-${B}`, storeId: ids[B] },
    ])
  })

  it('an error on one store is recorded and the next store still runs', async () => {
    const results = await forEachConnectedStore('sj-err', async (conn) => {
      if (conn.shop === A) throw new Error('Shopify answered 500')
      return 'fine'
    }, onlyMine())
    expect(results[0]).toMatchObject({ shop: A, ok: false, error: 'Shopify answered 500' })
    expect(results[1]).toMatchObject({ shop: B, ok: true, result: 'fine' })
    expect(await lastError(A)).toBe('[sj-err] Shopify answered 500')
    expect((await prisma.shopifyStore.findUnique({ where: { id: ids[A] } }))!.lastErrorAt).not.toBeNull()
    expect(await lastError(B)).toBeNull()
  })

  it("a connection failure (MINT_FAILED) counts as that store's error, not a crash", async () => {
    await makeStore(C, 10, null)
    await saveStoreCredential(ids[C], { authMode: 'CLIENT_CREDENTIALS', clientId: 'cid', clientSecret: 'sj-secret-value' })
    global.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const job = vi.fn(async () => 'ran')
    const results = await forEachConnectedStore('sj-mint', job, onlyMine())
    expect(results.map(r => [r.shop, r.ok])).toEqual([[A, true], [B, true], [C, false]])
    const failed = results[2]
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toContain(C)
    expect(job).toHaveBeenCalledTimes(2)
    expect(await lastError(C)).toContain(C)
    expect(await lastError(C)).not.toContain('sj-secret-value')
  })

  it('success clears lastError', async () => {
    await prisma.shopifyStore.update({ where: { id: ids[A] }, data: { lastError: '[sj-clear] old failure', lastErrorAt: new Date() } })
    await forEachConnectedStore('sj-clear', async () => 'ok', onlyMine())
    const store = await prisma.shopifyStore.findUnique({ where: { id: ids[A] } })
    expect(store!.lastError).toBeNull()
    expect(store!.lastErrorAt).toBeNull()
  })

  it("one job succeeding does not clear another job's error; the same job succeeding does", async () => {
    await forEachConnectedStore('sj-job-a', async () => { throw new Error('token revoked') }, { storeIds: [ids[A]] })
    expect(await lastError(A)).toBe('[sj-job-a] token revoked')

    await forEachConnectedStore('sj-job-b', async () => 'fine', { storeIds: [ids[A]] })
    expect(await lastError(A)).toBe('[sj-job-a] token revoked')
    expect((await prisma.shopifyStore.findUnique({ where: { id: ids[A] } }))!.lastErrorAt).not.toBeNull()

    await forEachConnectedStore('sj-job', async () => 'fine', { storeIds: [ids[A]] })
    expect(await lastError(A)).toBe('[sj-job-a] token revoked')

    await forEachConnectedStore('sj-job-a', async () => 'fine', { storeIds: [ids[A]] })
    const store = await prisma.shopifyStore.findUnique({ where: { id: ids[A] } })
    expect(store!.lastError).toBeNull()
    expect(store!.lastErrorAt).toBeNull()
  })

  it("the result still carries the bare message; only the stored text names the job", async () => {
    const results = await forEachConnectedStore('sj-bare', async () => { throw new Error('boom') }, { storeIds: [ids[A]] })
    expect(results[0]).toMatchObject({ ok: false, error: 'boom' })
    expect(await lastError(A)).toBe('[sj-bare] boom')
  })

  it('same job on the same store is skipped while running, without touching lastError', async () => {
    await prisma.shopifyStore.update({ where: { id: ids[A] }, data: { lastError: 'earlier failure' } })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const firstRun = forEachConnectedStore('sj-lock', async () => { await gate; return 'first' }, { storeIds: [ids[A]] })
    await tick(20)

    const second = await forEachConnectedStore('sj-lock', async () => 'second', { storeIds: [ids[A], ids[B]] })
    expect(second[0]).toMatchObject({ shop: A, ok: false, skipped: true })
    expect(second[1]).toMatchObject({ shop: B, ok: true, result: 'second' })
    expect(await lastError(A)).toBe('earlier failure')

    const otherJob = await forEachConnectedStore('sj-lock-other', async () => 'other', { storeIds: [ids[A]] })
    expect(otherJob[0]).toMatchObject({ ok: true, result: 'other' })

    release()
    const first = await firstRun
    expect(first[0]).toMatchObject({ ok: true, result: 'first' })
    const after = await forEachConnectedStore('sj-lock', async () => 'again', { storeIds: [ids[A]] })
    expect(after[0]).toMatchObject({ ok: true, result: 'again' })
  })

  it('runs only the stores asked for, and never a disabled or unconnected one', async () => {
    await makeStore(C, 10, null)
    await prisma.shopifyStore.update({ where: { id: ids[B] }, data: { enabled: false } })
    const shops: string[] = []
    await forEachConnectedStore('sj-scope', async conn => { shops.push(conn.shop) }, onlyMine())
    expect(shops).toEqual([A])
    shops.length = 0
    await prisma.shopifyStore.update({ where: { id: ids[B] }, data: { enabled: true } })
    await forEachConnectedStore('sj-scope', async conn => { shops.push(conn.shop) }, { storeIds: [ids[B]] })
    expect(shops).toEqual([B])
  })

  it('keeps tokens and secrets out of the stored error', async () => {
    const results = await forEachConnectedStore('sj-secret', async (conn) => {
      throw new Error(`GET https://x/y?access_token=abc123def456 failed; token ${conn.token}; header shpat_0123456789abcdef`)
    }, { storeIds: [ids[A]] })
    const stored = await lastError(A)
    expect(stored).toContain('failed')
    for (const text of [stored!, (results[0] as { error: string }).error]) {
      expect(text).not.toContain(`token-${A}`)
      expect(text).not.toContain('abc123def456')
      expect(text).not.toContain('shpat_0123456789abcdef')
    }
  })
})

describe('safeErrorText', () => {
  it('shortens long messages and names an empty one', () => {
    expect(safeErrorText(new Error('x'.repeat(2000))).length).toBeLessThan(600)
    expect(safeErrorText(new Error('  '))).toBe('Lỗi không rõ')
    expect(safeErrorText('plain')).toBe('plain')
  })
})

describe('mergeStoreResults', () => {
  it('is the single result for one store and sums counters and joins lists for several', () => {
    const ok = (shop: string, result: { n: number; errors: string[]; days: number }) => ({ storeId: shop, shop, ok: true as const, result })
    const failed = { storeId: 'z', shop: 'z', ok: false as const, error: 'boom' }
    expect(mergeStoreResults([ok('a', { n: 1, errors: ['x'], days: 30 })], { sum: ['n'], concat: ['errors'] }))
      .toEqual({ n: 1, errors: ['x'], days: 30 })
    expect(mergeStoreResults([ok('a', { n: 1, errors: ['x'], days: 30 }), failed, ok('b', { n: 2, errors: ['y'], days: 30 })], { sum: ['n'], concat: ['errors'] }))
      .toEqual({ n: 3, errors: ['x', 'y'], days: 30 })
    expect(mergeStoreResults([failed], { sum: ['n' as never] })).toBeNull()
  })
})

describe('payoutStartFor', () => {
  it('uses the store date, else SHOPIFY_PAYOUT_START_DATE', () => {
    expect(payoutStartFor({ payoutStartDate: '2026-10-06' })).toBe('2026-10-06')
    expect(payoutStartFor({ payoutStartDate: null })).toBe(SHOPIFY_PAYOUT_START_DATE)
  })
})
