import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { mintApproveToken, main } from '../scripts/review-queue/mint-approve-token.mjs'

let home: string
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

function fakes() {
  const seen: { token: string } = { token: '' }
  const encrypt = (t: string) => { seen.token = t; return `SEALED(${Buffer.from(t).toString('base64')})` }
  const decrypt = (file: string) => {
    const m = /^SEALED\((.*)\)$/.exec(fs.readFileSync(file, 'utf8').trim())
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : ''
  }
  return { seen, encrypt, decrypt }
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-mint-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('mint-approve-token', () => {
  it('prints only the sha256 of the generated token and never the token', async () => {
    const f = fakes()
    const out: string[] = []
    const err: string[] = []
    const code = await main({ env: { USERPROFILE: home }, argv: [], out: (m: string) => out.push(m), err: (m: string) => err.push(m), encrypt: f.encrypt, decrypt: f.decrypt })
    expect(code).toBe(0)
    expect(f.seen.token).toMatch(/^dap_[A-Za-z0-9_-]{43}$/)
    expect(out).toEqual([sha(f.seen.token)])
    expect([...out, ...err].join('\n')).not.toContain(f.seen.token)
    expect(fs.existsSync(path.join(home, '.review-queue', 'approve.dpapi'))).toBe(true)
  })

  it('refuses to overwrite without --force and keeps the old file', async () => {
    const f = fakes()
    await main({ env: { USERPROFILE: home }, argv: [], out: () => {}, err: () => {}, encrypt: f.encrypt, decrypt: f.decrypt })
    const file = path.join(home, '.review-queue', 'approve.dpapi')
    const before = fs.readFileSync(file, 'utf8')
    const err: string[] = []
    const out: string[] = []
    const code = await main({ env: { USERPROFILE: home }, argv: [], out: (m: string) => out.push(m), err: (m: string) => err.push(m), encrypt: f.encrypt, decrypt: f.decrypt })
    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err.join(' ')).toContain('--force')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    const forced = await main({ env: { USERPROFILE: home }, argv: ['--force'], out: () => {}, err: () => {}, encrypt: f.encrypt, decrypt: f.decrypt })
    expect(forced).toBe(0)
    expect(fs.readFileSync(file, 'utf8')).not.toBe(before)
  })

  it('deletes the file and fails when the decrypted token does not match', async () => {
    const f = fakes()
    const out: string[] = []
    const code = await main({ env: { USERPROFILE: home }, argv: [], out: (m: string) => out.push(m), err: () => {}, encrypt: f.encrypt, decrypt: () => 'dap_other' })
    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(fs.existsSync(path.join(home, '.review-queue', 'approve.dpapi'))).toBe(false)
  })

  it('mintApproveToken returns a fresh token each time', () => {
    const a = mintApproveToken(); const b = mintApproveToken()
    expect(a.token).not.toBe(b.token)
    expect(a.hash).toBe(sha(a.token))
  })
})
