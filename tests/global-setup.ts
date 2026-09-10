import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'file:./test.db'

export default function globalSetup() {
  if (!TEST_DATABASE_URL.startsWith('file:')) return
  const dbPath = path.resolve(process.cwd(), TEST_DATABASE_URL.slice('file:'.length))
  if (path.basename(dbPath) === 'dev.db') {
    throw new Error('Refusing to run the test suite against dev.db. Set TEST_DATABASE_URL to an isolated file.')
  }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix) } catch {}
  }
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  })
}
