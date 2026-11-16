import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dpapiDecrypt } from './actions.mjs'

// Mints the delivery approve token on this PC: writes it DPAPI-sealed to %USERPROFILE%\.review-queue\approve.dpapi and prints ONLY
// its sha256 hex on stdout. The owner stores that hash on prod as the approve-token hash; the token never leaves this PC.
//   node scripts/review-queue/mint-approve-token.mjs [--force]

export function mintApproveToken() {
  const token = `dap_${crypto.randomBytes(32).toString('base64url')}`
  return { token, hash: crypto.createHash('sha256').update(token, 'utf8').digest('hex') }
}

/** DPAPI user-scope ciphertext of `token`; the token goes in on stdin, never on the command line. */
export function dpapiEncrypt(token) {
  const script = '$t = [Console]::In.ReadToEnd().Trim(); $t | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString'
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { input: token, encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] })
}

export async function main({ env = process.env, argv = process.argv.slice(2), out = console.log, err = console.error, encrypt = dpapiEncrypt, decrypt = dpapiDecrypt } = /** @type {any} */ ({})) {
  const dir = path.join(env.USERPROFILE || os.homedir(), '.review-queue')
  const file = path.join(dir, 'approve.dpapi')
  if (fs.existsSync(file) && !argv.includes('--force')) {
    err(`${file} đã có — chạy lại với --force để thay (token cũ sẽ mất)`)
    return 1
  }
  const { token, hash } = mintApproveToken()
  const tmp = `${file}.tmp`
  let back
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, String(encrypt(token)).trim() + '
', 'utf8')
    back = String(decrypt(tmp) ?? '').trim()
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    err(`LỖI: không mã hoá được token (${e instanceof Error ? e.message.split(/\r?\n/)[0] : 'lỗi'})`)
    return 1
  }
  if (back !== token) {
    fs.rmSync(tmp, { force: true })
    err('LỖI: giải mã lại không khớp token vừa tạo — approve.dpapi giữ nguyên')
    return 1
  }
  fs.renameSync(tmp, file)
  out(hash)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code })
}
