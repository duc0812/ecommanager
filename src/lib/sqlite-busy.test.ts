import { describe, it, expect } from 'vitest'
import { isBusyError, retryOnBusy, BUSY_RETRY_DELAYS_MS } from '@/lib/sqlite-busy'

describe('isBusyError', () => {
  it('true on SQLITE_BUSY code', () => {
    expect(isBusyError({ code: 'SQLITE_BUSY' })).toBe(true)
  })
  it('true on nested cause code', () => {
    expect(isBusyError({ message: 'boom', cause: { code: 'SQLITE_LOCKED' } })).toBe(true)
  })
  it('true on "database is locked" message', () => {
    expect(isBusyError(new Error('SqliteError: database is locked'))).toBe(true)
  })
  it('false on unrelated errors', () => {
    expect(isBusyError(new Error('Unique constraint failed'))).toBe(false)
    expect(isBusyError({ code: 'P2002' })).toBe(false)
    expect(isBusyError(undefined)).toBe(false)
  })
  it('false on SocketTimeout — retrying a 10s engine timeout would only stack waits', () => {
    expect(isBusyError(new Error('DriverAdapterError: SocketTimeout'))).toBe(false)
  })
})

describe('retryOnBusy', () => {
  it('returns the first successful result without retrying', async () => {
    let calls = 0
    const out = await retryOnBusy(async () => { calls++; return 'ok' })
    expect(out).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries a busy error then succeeds', async () => {
    let calls = 0
    const out = await retryOnBusy(async () => {
      calls++
      if (calls < 3) throw { code: 'SQLITE_BUSY' }
      return calls
    })
    expect(out).toBe(3)
  })

  it('rethrows a non-busy error immediately', async () => {
    let calls = 0
    await expect(retryOnBusy(async () => { calls++; throw new Error('Unique constraint failed') }))
      .rejects.toThrow('Unique constraint failed')
    expect(calls).toBe(1)
  })

  it('gives up after the configured attempts', async () => {
    let calls = 0
    await expect(retryOnBusy(async () => { calls++; throw { code: 'SQLITE_BUSY', message: 'busy' } }))
      .rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    expect(calls).toBe(BUSY_RETRY_DELAYS_MS.length + 1)
  })
})
