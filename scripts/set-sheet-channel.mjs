// Saves a supplier's sheet channel. Dry run by default; --apply writes.
//   node scripts/set-sheet-channel.mjs scripts/data/sheet-channel-jomall.json [--spreadsheet <id>] [--enable | --disable] [--apply]
// --spreadsheet points the channel at a test copy first. Turning a channel on stops that supplier's CSV export.
import fs from 'fs'
import path from 'path'
import { createClient } from '@libsql/client'

const KEY = 'supplier.sheetChannels'
const args = process.argv.slice(2)
const file = args.find(a => a.endsWith('.json'))
if (!file) throw new Error('Pass the channel JSON file')
const after = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const channel = JSON.parse(fs.readFileSync(file, 'utf8'))
if (after('--spreadsheet')) channel.spreadsheetId = after('--spreadsheet')
if (args.includes('--enable')) channel.enabled = true
if (args.includes('--disable')) channel.enabled = false

const db = createClient({ url: process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}` })
const row = (await db.execute({ sql: 'SELECT value FROM "AppSetting" WHERE key = ?', args: [KEY] })).rows[0]
const list = row ? JSON.parse(String(row.value)) : []
const next = [...list.filter(c => c.supplierCode !== channel.supplierCode), channel]

console.log(`${channel.supplierCode}: enabled=${channel.enabled} sheet=${channel.spreadsheetId} tabs=${channel.tabPattern} columns=${channel.columns.length}`)
if (!args.includes('--apply')) {
  console.log('DRY RUN, nothing written. Add --apply.')
  process.exit(0)
}
await db.execute({
  sql: `INSERT INTO "AppSetting" (key, value, updatedAt) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
  args: [KEY, JSON.stringify(next), new Date().toISOString()],
})
console.log('Saved.')
