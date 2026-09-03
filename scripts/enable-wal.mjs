// One-off: switch the SQLite DB file to WAL journal mode (persistent in the file header).
// Run with the app STOPPED. Usage: node scripts/enable-wal.mjs /home/podmanager/dev.db
import { createClient } from '@libsql/client'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/enable-wal.mjs <absolute-path-to-dev.db>')
  process.exit(1)
}

const client = createClient({ url: `file:${path}` })
const show = async (label, sql) => {
  const r = await client.execute(sql)
  console.log(`${label}: ${JSON.stringify(r.rows)}`)
  return r
}

try {
  await show('before      ', 'PRAGMA journal_mode')
  await show('set         ', 'PRAGMA journal_mode=WAL')
  await show('after       ', 'PRAGMA journal_mode')
  await show('autocheckpt ', 'PRAGMA wal_autocheckpoint')
  await show('integrity   ', 'PRAGMA integrity_check')
} catch (e) {
  console.error('FAILED', e)
  process.exit(1)
} finally {
  client.close()
}
