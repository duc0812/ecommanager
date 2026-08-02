import path from 'path'
import { describe, expect, it } from 'vitest'
import { resolveDatabaseUrl } from '@/lib/database-url'

describe('resolveDatabaseUrl', () => {
  it('resolves a relative SQLite URL from the application working directory', () => {
    const cwd = path.resolve('app-root')
    expect(resolveDatabaseUrl('file:./data/ecom.db', cwd)).toBe(
      `file:${path.resolve(cwd, './data/ecom.db')}`,
    )
  })

  it('keeps non-file LibSQL URLs unchanged', () => {
    expect(resolveDatabaseUrl('libsql://example.turso.io', 'ignored')).toBe('libsql://example.turso.io')
  })

  it('falls back to dev.db when DATABASE_URL is absent', () => {
    const cwd = path.resolve('app-root')
    expect(resolveDatabaseUrl(undefined, cwd)).toBe(`file:${path.resolve(cwd, 'dev.db')}`)
  })
})
